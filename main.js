const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

// --- World / court geometry (world units) -----------------------------
// x: 左右 (-180..180), y: 高さ (0=地面), z: 奥行き (負=自陣, 正=CPU陣)
const COURT_HALF_W = 180;
const COURT_DEPTH = 300;   // 各陣の奥行き
const NET_H = 130;
const WALL_X = 200;        // 見えない壁（ボールを場内に留める）
const WALL_Z = 320;
const CHAR_R = 20;
const BALL_R = 10;
const WIN_SCORE = 5;
const MAX_TOUCHES = 3;

// --- Camera (自陣後方から相手コートを見る固定カメラ) -------------------
const CAM_Z = -700;
const CAM_H = 200;
const FOCAL = 540;
const HORIZON_Y = 120;

function proj(wx, wy, wz) {
  const t = FOCAL / (wz - CAM_Z);
  return { x: W / 2 + wx * t, y: HORIZON_Y + (CAM_H - wy) * t, t };
}

// --- Game state -------------------------------------------------------
const STATE = { TITLE: 'title', PLAYING: 'playing', GAMEOVER: 'gameover' };
let state = STATE.TITLE;

let score = { player: 0, cpu: 0 };
let touches = { player: 0, cpu: 0 };
let serveSide = 'player';
let serveTimer = 0;
let winner = null;
let lastBallSide = 'player';
let cpuReactTimer = 0;
let cpuAimErr = { x: 0, z: 0 };
let allyAimErr = { x: 0, z: 0 };
let waitingServe = false;
let tick = 0;
let rallyLen = 0; // このラリーでボールがネットを越えた回数
let lastToucher = null; // 同じキャラは連続でボールに触れない

const keys = {};
window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (state === STATE.TITLE) startGame();
  else if (state === STATE.PLAYING && waitingServe && e.code === 'Enter') waitingServe = false;
  else if (state === STATE.GAMEOVER && e.code === 'KeyR') state = STATE.TITLE;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// --- Teams -------------------------------------------------------------
// index 0 = 後衛センター(サーバー・操作キャラ), 1/2 = 前衛左右
const HOME = {
  player: [{ x: 0, z: -230 }, { x: -120, z: -100 }, { x: 120, z: -100 }],
  cpu: [{ x: 0, z: 230 }, { x: -120, z: 100 }, { x: 120, z: 100 }],
};
const CONTROLLED_INDEX = 0;
const COLOR = { controlled: '#3ddb6e', ally: '#3aa0ff', cpu: '#ff5555' };

let teams = { player: [], cpu: [] };
let ball;

function makeChar(home, color, side) {
  return {
    x: home.x, z: home.z, y: 0,
    vx: 0, vy: 0, vz: 0,
    color, side, home,
    onGround: true,
    hitCooldown: 0,
  };
}

function controlled() { return teams.player[CONTROLLED_INDEX]; }
function opponent(side) { return side === 'player' ? 'cpu' : 'player'; }

function resetPositions() {
  teams.player = HOME.player.map((h, i) =>
    makeChar(h, i === CONTROLLED_INDEX ? COLOR.controlled : COLOR.ally, 'player'));
  teams.cpu = HOME.cpu.map((h) => makeChar(h, COLOR.cpu, 'cpu'));
  ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, held: true };
}

function startGame() {
  score = { player: 0, cpu: 0 };
  serveSide = Math.random() < 0.5 ? 'player' : 'cpu';
  winner = null;
  resetPositions();
  beginServe();
  state = STATE.PLAYING;
}

function beginServe() {
  touches = { player: 0, cpu: 0 };
  cpuReactTimer = 0;
  lastBallSide = serveSide;
  for (const side of ['player', 'cpu']) {
    for (const c of teams[side]) {
      c.x = c.home.x; c.z = c.home.z; c.y = 0;
      c.vx = 0; c.vy = 0; c.vz = 0;
      c.onGround = true;
      c.hitCooldown = 0;
    }
  }
  const server = teams[serveSide][0];
  ball.x = server.x;
  ball.y = CHAR_R * 2 + BALL_R + 30;
  ball.z = server.z;
  ball.vx = 0; ball.vy = 0; ball.vz = 0;
  ball.held = true;
  serveTimer = 60;
  rallyLen = 0;
  lastToucher = null;
  waitingServe = true; // Enter(サーブボタン)が押されるまで待機
}

function launchServe() {
  const dir = serveSide === 'player' ? 1 : -1;
  const level = difficultyLevel();
  const T = 76 - level * 2;
  aimAt(dir * (120 + Math.random() * 140), (Math.random() * 2 - 1) * 120, T);
  ball.held = false;
  lastToucher = teams[serveSide][0];
}

// CPUの落下点の読み違い。相手の攻撃が来るたびに引き直す（レベルが上がるほど正確）。
// ラリーが長引くほど乱れて、勝負が必ず決着するようにする
function rollCpuErr() {
  const mag = 42 - difficultyLevel() * 10 + rallyLen * 1.5;
  cpuAimErr = { x: (Math.random() * 2 - 1) * mag, z: (Math.random() * 2 - 1) * mag };
}

// 目標地点(tz, tx)へ滞空Tフレームで届く初速を逆算し、ネット超えを保証する
function aimAt(tz, tx, T) {
  const g = gravity();
  ball.vx = (tx - ball.x) / T;
  ball.vz = (tz - ball.z) / T;
  ball.vy = (BALL_R - ball.y + g * T * (T + 1) / 2) / T;
  if ((ball.z < 0) !== (tz < 0)) {
    const n = Math.max(1, Math.abs(ball.z / ball.vz));
    const yAtNet = ball.y + ball.vy * n - g * n * (n + 1) / 2;
    const clearY = NET_H + 25;
    if (yAtNet < clearY) ball.vy = (clearY - ball.y + g * n * (n + 1) / 2) / n;
  }
}

// --- Difficulty scaling -------------------------------------------------
function difficultyLevel() {
  const total = score.player + score.cpu;
  if (total >= 6) return 3;
  if (total >= 4) return 2;
  if (total >= 2) return 1;
  return 0;
}

function gravity() {
  return 0.5 + difficultyLevel() * 0.03;
}

// --- Input / movement ---------------------------------------------------
const PLAYER_SPEED = 4.5;
const ALLY_SPEED = 3.2;
const JUMP_VELOCITY = 13;
const CHAR_GRAVITY = 0.7;

function updatePlayer() {
  const p = controlled();
  p.vx = 0; p.vz = 0;
  if (keys['ArrowLeft']) p.vx = -PLAYER_SPEED;
  if (keys['ArrowRight']) p.vx = PLAYER_SPEED;
  if (keys['ArrowUp']) p.vz = PLAYER_SPEED;
  if (keys['ArrowDown']) p.vz = -PLAYER_SPEED;
  const jumpKey = keys['Space'];
  if (jumpKey && p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
  }
  applyCharPhysics(p, 'player');

  // Sでヒット。接触中にジャンプ入力でも打ち返せる
  if (!ball.held && p.hitCooldown === 0 && (keys['KeyS'] || jumpKey) && nearBall(p, 18)) {
    performHit(p);
  }
}

function updateCpuTeam() {
  const level = difficultyLevel();
  const headed = !ball.held && (ball.z > 0 || ball.vz > 0);
  cpuReactTimer = headed ? cpuReactTimer + 1 : 0;
  const reactDelay = 20 - level * 4;
  let landing = cpuReactTimer >= reactDelay ? predictLanding('cpu') : null;
  if (landing !== null) {
    // 読み違えるのは相手からの返球のみ。自チームのトスは正確に追える
    const err = touches.cpu > 0 ? { x: 0, z: 0 } : cpuAimErr;
    landing = {
      x: clamp(landing.x + err.x, -WALL_X + CHAR_R, WALL_X - CHAR_R),
      z: clamp(landing.z + err.z, 15, WALL_Z - CHAR_R),
    };
  }
  // 直前に触ったキャラは連続で触れないので追いかけ役から外す
  const chaser = landing !== null
    ? nearestChar(teams.cpu.filter((c) => c !== lastToucher), landing)
    : null;

  for (const c of teams.cpu) {
    const isChaser = c === chaser;
    moveToward(c, isChaser ? landing : c.home, isChaser ? 3.3 + level * 0.45 : 2.2);
    // 3回目(スパイク)は落下点で待ち、ボールが降りてきたらジャンプして叩く
    if (isChaser && c.onGround && touches.cpu === MAX_TOUCHES - 1 && ball.z > 0 && ball.vy < 0) {
      if (distXZ(c, ball) < 28 && ball.y < 190) {
        c.vy = JUMP_VELOCITY;
        c.onGround = false;
      }
    }
    applyCharPhysics(c, 'cpu');
    if (!ball.held && c.hitCooldown === 0 && ball.z > 0 && nearBall(c, 6)) {
      performHit(c);
    }
  }
}

function updateAllies() {
  let landing = predictLanding('player');
  const pc = controlled();
  if (landing !== null && touches.player === 0) {
    // 味方も相手からの返球は少し読み違える（自チームのトスは正確）
    landing = {
      x: clamp(landing.x + allyAimErr.x, -WALL_X + CHAR_R, WALL_X - CHAR_R),
      z: clamp(landing.z + allyAimErr.z, -WALL_Z + CHAR_R, -15),
    };
  }
  // 落下点が操作プレイヤーの近くなら味方は譲る（プレイヤーのボール）。
  // ただし操作プレイヤーが直前に触った場合は連続で触れないので味方が拾う
  let chaser = null;
  if (landing !== null && (pc === lastToucher || Math.hypot(landing.x - pc.x, landing.z - pc.z) > 90)) {
    chaser = nearestChar(teams.player.filter((c) => c !== pc && c !== lastToucher), landing);
  }
  for (const c of teams.player) {
    if (c === pc) continue;
    const isChaser = c === chaser;
    moveToward(c, isChaser ? landing : c.home, ALLY_SPEED);
    // 3回目(スパイク)は味方AIもジャンプして叩く
    if (isChaser && c.onGround && touches.player === MAX_TOUCHES - 1 && ball.z < 0 && ball.vy < 0) {
      if (distXZ(c, ball) < 28 && ball.y < 190) {
        c.vy = JUMP_VELOCITY;
        c.onGround = false;
      }
    }
    applyCharPhysics(c, 'player');
    if (!ball.held && c.hitCooldown === 0 && ball.z < 0 && nearBall(c, 6)) {
      performHit(c);
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function distXZ(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

function nearBall(c, pad) {
  const dy = ball.y - (c.y + CHAR_R);
  return Math.hypot(ball.x - c.x, dy, ball.z - c.z) < CHAR_R + BALL_R + pad;
}

function nearestChar(list, p) {
  return list.reduce((best, c) => (distXZ(c, p) < distXZ(best, p) ? c : best));
}

function moveToward(c, target, speed) {
  const dx = target.x - c.x;
  const dz = target.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d > 4) {
    c.vx = (dx / d) * speed;
    c.vz = (dz / d) * speed;
  } else {
    c.vx = 0; c.vz = 0;
  }
}

function predictLanding(side) {
  if (ball.held) return null;
  let sx = ball.x, sy = ball.y, sz = ball.z;
  let svx = ball.vx, svy = ball.vy, svz = ball.vz;
  const g = gravity();
  for (let i = 0; i < 300; i++) {
    svy -= g;
    sx += svx; sy += svy; sz += svz;
    if (sx < -WALL_X + BALL_R) { sx = -WALL_X + BALL_R; svx *= -1; }
    if (sx > WALL_X - BALL_R) { sx = WALL_X - BALL_R; svx *= -1; }
    if (sz < -WALL_Z + BALL_R) { sz = -WALL_Z + BALL_R; svz *= -1; }
    if (sz > WALL_Z - BALL_R) { sz = WALL_Z - BALL_R; svz *= -1; }
    if (sy <= BALL_R) break;
  }
  const onSide = side === 'player' ? sz < 0 : sz > 0;
  if (!onSide) return null;
  const zLo = side === 'player' ? -WALL_Z + CHAR_R : 15;
  const zHi = side === 'player' ? -15 : WALL_Z - CHAR_R;
  return { x: clamp(sx, -WALL_X + CHAR_R, WALL_X - CHAR_R), z: clamp(sz, zLo, zHi) };
}

function applyCharPhysics(c, side) {
  c.x += c.vx;
  c.z += c.vz;
  c.x = clamp(c.x, -WALL_X + CHAR_R, WALL_X - CHAR_R);
  if (side === 'player') c.z = clamp(c.z, -WALL_Z + CHAR_R, -15);
  else c.z = clamp(c.z, 15, WALL_Z - CHAR_R);

  c.vy -= CHAR_GRAVITY;
  c.y += c.vy;
  if (c.y <= 0) {
    c.y = 0;
    c.vy = 0;
    c.onGround = true;
  }
  if (c.hitCooldown > 0) c.hitCooldown--;
}

// --- Hitting -------------------------------------------------------------
// 1・2回目のタッチは自陣前方へのトス、3回目だけが相手コートへのスパイク。
// スパイクはジャンプ中(空中)でなければ打てない。
function performHit(c) {
  const side = c.side;
  if (c === lastToucher) return; // 同じキャラは連続で触れない
  if (touches[side] >= MAX_TOUCHES) {
    awardPoint(opponent(side)); // オーバータッチ
    return;
  }
  const isSpike = touches[side] === MAX_TOUCHES - 1;
  if (isSpike && c.onGround) return; // 3回目はジャンプしないと返せない
  touches[side]++;
  lastToucher = c;
  const dir = side === 'player' ? 1 : -1;
  const level = difficultyLevel();
  if (isSpike) {
    const T = 64 - level * 3;
    aimAt(dir * (60 + Math.random() * 200), (Math.random() * 2 - 1) * 140, T);
  } else {
    // 自陣ネット手前・中央寄りへ高いトスを上げる
    aimAt(-dir * (55 + Math.random() * 30), ball.x * 0.3 + (Math.random() * 2 - 1) * 30, 55);
  }
  c.hitCooldown = 12;
}

// --- Ball physics ----------------------------------------------------------
function updateBall() {
  if (ball.held) return;

  const prevZ = ball.z;
  ball.vy -= gravity();
  ball.x += ball.vx;
  ball.y += ball.vy;
  ball.z += ball.vz;

  // 見えない壁で場内に留める
  if (ball.x < -WALL_X + BALL_R) { ball.x = -WALL_X + BALL_R; ball.vx *= -1; }
  if (ball.x > WALL_X - BALL_R) { ball.x = WALL_X - BALL_R; ball.vx *= -1; }
  if (ball.z < -WALL_Z + BALL_R) { ball.z = -WALL_Z + BALL_R; ball.vz *= -1; }
  if (ball.z > WALL_Z - BALL_R) { ball.z = WALL_Z - BALL_R; ball.vz *= -1; }

  // ネット判定: ネット面(z=0)を高さ不足で越えようとしたらブロック
  if ((prevZ < 0) !== (ball.z < 0) && ball.y < NET_H + BALL_R) {
    ball.z = prevZ < 0 ? -BALL_R - 3 : BALL_R + 3;
    ball.vz *= -0.5;
    ball.vx *= 0.7;
  }

  // コートを越えたらそちら側のタッチ回数をリセット
  const sideNow = ball.z < 0 ? 'player' : 'cpu';
  if (sideNow !== lastBallSide) {
    lastBallSide = sideNow;
    touches[sideNow] = 0;
    rallyLen++;
    if (sideNow === 'cpu') rollCpuErr();
    else allyAimErr = { x: (Math.random() * 2 - 1) * 34, z: (Math.random() * 2 - 1) * 34 };
  }

  // ground -> point
  if (ball.y <= BALL_R) {
    awardPoint(ball.z < 0 ? 'cpu' : 'player');
  }
}

function awardPoint(side) {
  score[side]++;
  if (score[side] >= WIN_SCORE) {
    winner = side;
    state = STATE.GAMEOVER;
    return;
  }
  serveSide = side;
  beginServe();
}

// --- Main loop --------------------------------------------------------------
function update() {
  if (state !== STATE.PLAYING || waitingServe) return;

  updatePlayer();
  updateCpuTeam();
  updateAllies();

  if (ball.held) {
    serveTimer--;
    const server = teams[serveSide][0];
    ball.x = server.x;
    ball.z = server.z;
    ball.y = CHAR_R * 2 + BALL_R + 30;
    if (serveTimer <= 0) launchServe();
  } else {
    updateBall();
  }
}

// --- Rendering ----------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawCourt();

  if (state === STATE.TITLE) {
    drawTitle();
    return;
  }

  drawLandingMarker();

  // 奥(CPU)チーム → ネット奥のボール → ネット → ネット手前のボール → 手前チーム
  const farChars = teams.cpu.slice().sort((a, b) => b.z - a.z);
  for (const c of farChars) drawChar(c);
  if (ball.z > 0) drawBall();
  drawNet();
  if (ball.z <= 0) drawBall();
  const nearChars = teams.player.slice().sort((a, b) => b.z - a.z);
  for (const c of nearChars) drawChar(c);

  drawScore();
  if (ball.held) drawServeLabel();
  if (state === STATE.GAMEOVER) drawGameOver();
}

function drawBackground() {
  // 空
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 40);
  sky.addColorStop(0, '#13334d');
  sky.addColorStop(1, '#2b5876');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, HORIZON_Y + 40);
  // 地面
  ctx.fillStyle = '#255a25';
  ctx.fillRect(0, HORIZON_Y + 40, W, H - HORIZON_Y - 40);
}

function courtQuad(x1, z1, x2, z2) {
  const a = proj(x1, 0, z2);
  const b = proj(x2, 0, z2);
  const c = proj(x2, 0, z1);
  const d = proj(x1, 0, z1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

function line3d(x1, y1, z1, x2, y2, z2) {
  const a = proj(x1, y1, z1);
  const b = proj(x2, y2, z2);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawCourt() {
  // コート面
  courtQuad(-COURT_HALF_W, -COURT_DEPTH, COURT_HALF_W, COURT_DEPTH);
  ctx.fillStyle = '#2f6b2f';
  ctx.fill();
  // 自陣をわずかに明るくして手前感を出す
  courtQuad(-COURT_HALF_W, -COURT_DEPTH, COURT_HALF_W, 0);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  // 外周ライン
  courtQuad(-COURT_HALF_W, -COURT_DEPTH, COURT_HALF_W, COURT_DEPTH);
  ctx.stroke();
  // センターライン(ネット下)とアタックライン
  line3d(-COURT_HALF_W, 0, 0, COURT_HALF_W, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  line3d(-COURT_HALF_W, 0, -100, COURT_HALF_W, 0, -100);
  line3d(-COURT_HALF_W, 0, 100, COURT_HALF_W, 0, 100);
  ctx.lineWidth = 1;
}

function drawNet() {
  const postL = proj(-COURT_HALF_W - 10, 0, 0);
  const postLT = proj(-COURT_HALF_W - 10, NET_H, 0);
  const postR = proj(COURT_HALF_W + 10, 0, 0);
  const postRT = proj(COURT_HALF_W + 10, NET_H, 0);

  // 網(半透明)
  ctx.fillStyle = 'rgba(220,220,220,0.28)';
  ctx.beginPath();
  ctx.moveTo(postLT.x, postLT.y);
  ctx.lineTo(postRT.x, postRT.y);
  ctx.lineTo(postR.x, postR.y);
  ctx.lineTo(postL.x, postL.y);
  ctx.closePath();
  ctx.fill();

  // 網目
  ctx.strokeStyle = 'rgba(230,230,230,0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const y = (NET_H / 8) * i;
    line3d(-COURT_HALF_W - 10, y, 0, COURT_HALF_W + 10, y, 0);
  }
  for (let x = -COURT_HALF_W; x <= COURT_HALF_W; x += 36) {
    line3d(x, 0, 0, x, NET_H, 0);
  }

  // 白帯(上端)と支柱
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  line3d(-COURT_HALF_W - 10, NET_H, 0, COURT_HALF_W + 10, NET_H, 0);
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 3;
  line3d(-COURT_HALF_W - 10, 0, 0, -COURT_HALF_W - 10, NET_H, 0);
  line3d(COURT_HALF_W + 10, 0, 0, COURT_HALF_W + 10, NET_H, 0);
  ctx.lineWidth = 1;
}

// ボールの予測落下地点を明滅するリングで示す
function drawLandingMarker() {
  if (ball.held || state !== STATE.PLAYING) return;
  const lp = predictLanding('player') || predictLanding('cpu');
  if (!lp) return;
  const p = proj(lp.x, 0, lp.z);
  const pulse = 0.5 + 0.5 * Math.sin(tick * 0.18);
  const r = (16 + 8 * pulse) * p.t;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 230, 90, ${0.12 + 0.15 * pulse})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(255, 230, 90, ${0.55 + 0.4 * pulse})`;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawShadow(wx, wy, wz, baseR) {
  const s = proj(wx, 0, wz);
  const size = Math.max(0.25, 1 - wy / 260);
  ctx.beginPath();
  ctx.ellipse(s.x, s.y, baseR * s.t * size, baseR * s.t * size * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
}

function drawChar(c) {
  drawShadow(c.x, c.y, c.z, CHAR_R * 1.1);
  const p = proj(c.x, c.y + CHAR_R, c.z);
  const r = CHAR_R * p.t * 1.15;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = c.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.stroke();
  // 操作キャラの目印
  if (c === controlled()) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - r - 6);
    ctx.lineTo(p.x - 7, p.y - r - 18);
    ctx.lineTo(p.x + 7, p.y - r - 18);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

function drawBall() {
  drawShadow(ball.x, ball.y, ball.z, BALL_R * 1.3);
  const p = proj(ball.x, ball.y, ball.z);
  const r = Math.max(3.5, BALL_R * p.t * 1.3);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.stroke();
}

function drawScore() {
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${score.player}  -  ${score.cpu}`, W / 2, 42);
  ctx.font = '14px sans-serif';
  ctx.fillText('プレイヤー', W / 2 - 100, 42);
  ctx.fillText('CPU', W / 2 + 90, 42);

  // 現在ボールがある側のタッチ回数
  if (!ball.held) {
    ctx.font = '13px sans-serif';
    ctx.fillText(`タッチ ${touches[lastBallSide]}/${MAX_TOUCHES}`, W / 2, 64);
  }
}

function drawServeLabel() {
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(serveSide === 'player' ? 'あなたのサーブ' : 'CPUのサーブ', W / 2, 92);
  if (waitingServe) {
    ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(tick * 0.1)})`;
    ctx.font = '16px sans-serif';
    ctx.fillText('Enter でサーブ開始', W / 2, 118);
  }
}

function drawTitle() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('ブラウザ・バレーボール 3 vs 3', W / 2, H / 2 - 80);
  ctx.font = '18px sans-serif';
  ctx.fillText('← → ↑ ↓ : 移動    Space : ジャンプ    S : 打つ    Enter : サーブ', W / 2, H / 2 - 20);
  ctx.fillText('3タッチ目はジャンプスパイクで返す。同じキャラは連続で触れない', W / 2, H / 2 + 10);
  ctx.fillText(`先に ${WIN_SCORE} 点取ったら勝ち`, W / 2, H / 2 + 40);
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('press any key to start', W / 2, H / 2 + 95);
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText(winner === 'player' ? 'WIN!' : 'LOSE...', W / 2, H / 2 - 20);
  ctx.font = '22px sans-serif';
  ctx.fillText(`最終スコア  ${score.player} - ${score.cpu}`, W / 2, H / 2 + 20);
  ctx.fillText('press R to restart', W / 2, H / 2 + 60);
}

function loop() {
  tick++;
  update();
  draw();
  requestAnimationFrame(loop);
}

resetPositions();
loop();
