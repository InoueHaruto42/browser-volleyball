const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

// --- Court geometry -------------------------------------------------
const GROUND_Y = 400;
const NET_X = 400;
const NET_TOP = 290;
const NET_WIDTH = 6;
const COURT_LEFT = 20;
const COURT_RIGHT = 780;
const CHAR_RADIUS = 18;
const BALL_RADIUS = 10;
const WIN_SCORE = 5;
const MAX_TOUCHES = 3;

// --- Game state -------------------------------------------------
const STATE = { TITLE: 'title', PLAYING: 'playing', GAMEOVER: 'gameover' };
let state = STATE.TITLE;

let score = { player: 0, cpu: 0 };
let touches = { player: 0, cpu: 0 };
let serveSide = 'player';
let serveTimer = 0;
let winner = null;
let lastBallSide = 'player';
let cpuReactTimer = 0;
let cpuAimError = 0;

const keys = {};
window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'Enter'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (state === STATE.TITLE) startGame();
  else if (state === STATE.GAMEOVER && e.code === 'KeyR') state = STATE.TITLE;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// --- Teams -------------------------------------------------
// index 0 = 後衛(サーバー), 1 = 中衛, 2 = 前衛。プレイヤーが操作するのは中衛の1人。
const HOME_X = { player: [100, 220, 320], cpu: [700, 580, 480] };
const CONTROLLED_INDEX = 1;
const COLOR = { controlled: '#3ddb6e', ally: '#3aa0ff', cpu: '#ff5555' };

let teams = { player: [], cpu: [] };
let ball;

function makeChar(homeX, color, side) {
  return {
    x: homeX, y: GROUND_Y - CHAR_RADIUS,
    vx: 0, vy: 0,
    color, side, homeX,
    onGround: true,
    hitCooldown: 0,
  };
}

function controlled() { return teams.player[CONTROLLED_INDEX]; }
function opponent(side) { return side === 'player' ? 'cpu' : 'player'; }

function resetPositions() {
  teams.player = HOME_X.player.map((x, i) =>
    makeChar(x, i === CONTROLLED_INDEX ? COLOR.controlled : COLOR.ally, 'player'));
  teams.cpu = HOME_X.cpu.map((x) => makeChar(x, COLOR.cpu, 'cpu'));
  ball = { x: 0, y: 0, vx: 0, vy: 0, held: true };
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
      c.x = c.homeX;
      c.y = GROUND_Y - CHAR_RADIUS;
      c.vx = 0; c.vy = 0;
      c.onGround = true;
      c.hitCooldown = 0;
    }
  }
  const server = teams[serveSide][0];
  ball.x = server.x;
  ball.y = GROUND_Y - CHAR_RADIUS - BALL_RADIUS - 40;
  ball.vx = 0;
  ball.vy = 0;
  ball.held = true;
  serveTimer = 60;
}

function launchServe() {
  const dir = serveSide === 'player' ? 1 : -1;
  ball.vx = dir * (8 + difficultyLevel() * 0.4);
  ball.vy = -12;
  ball.held = false;
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

// --- Input / movement -------------------------------------------------
const PLAYER_SPEED = 4.2;
const ALLY_SPEED = 3.0;
const JUMP_VELOCITY = -10.5;
const CHAR_GRAVITY = 0.6;

function updatePlayer() {
  const p = controlled();
  p.vx = 0;
  if (keys['ArrowLeft'] || keys['KeyA']) p.vx = -PLAYER_SPEED;
  if (keys['ArrowRight'] || keys['KeyD']) p.vx = PLAYER_SPEED;
  const jumpKey = keys['Space'] || keys['ArrowUp'];
  if (jumpKey && p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
  }
  applyCharPhysics(p, COURT_LEFT + CHAR_RADIUS, NET_X - NET_WIDTH / 2 - CHAR_RADIUS);

  // Enterでヒット。接触中にジャンプ入力でも打ち返せる
  if (!ball.held && p.hitCooldown === 0 && (keys['Enter'] || jumpKey) && nearBall(p, 14)) {
    performHit(p, 'over');
  }
}

function updateCpuTeam() {
  const level = difficultyLevel();
  const headed = !ball.held && (ball.x > NET_X || ball.vx > 0);
  cpuReactTimer = headed ? cpuReactTimer + 1 : 0;
  const reactDelay = 18 - level * 4;
  // 反応した瞬間に落下点の読み違いを決める（レベルが上がるほど正確になる）
  if (cpuReactTimer === reactDelay) cpuAimError = (Math.random() * 2 - 1) * (40 - level * 10);
  let landing = cpuReactTimer >= reactDelay ? predictLandingX('cpu') : null;
  if (landing !== null) {
    landing = Math.max(NET_X + NET_WIDTH / 2 + CHAR_RADIUS,
      Math.min(COURT_RIGHT - CHAR_RADIUS, landing + cpuAimError));
  }
  const chaser = landing !== null ? nearestChar(teams.cpu, landing) : null;

  for (const c of teams.cpu) {
    const isChaser = c === chaser;
    moveToward(c, isChaser ? landing : c.homeX, isChaser ? 3.2 + level * 0.5 : 2.0);
    // ほぼ真上まで落ちてきたボールだけジャンプで叩く（早すぎるジャンプは空振りする）
    if (isChaser && c.onGround && ball.x > NET_X && ball.vy > 0) {
      if (Math.abs(ball.x - c.x) < 20 && ball.y > 270 && ball.y < 330) {
        c.vy = JUMP_VELOCITY;
        c.onGround = false;
      }
    }
    applyCharPhysics(c, NET_X + NET_WIDTH / 2 + CHAR_RADIUS, COURT_RIGHT - CHAR_RADIUS);
    if (!ball.held && c.hitCooldown === 0 && ball.x > NET_X && nearBall(c, 4)) {
      aiHit(c);
    }
  }
}

function updateAllies() {
  const landing = predictLandingX('player');
  const pc = controlled();
  // 落下点が操作プレイヤーの近くなら味方は譲る（プレイヤーのボール）
  let chaser = null;
  if (landing !== null && Math.abs(landing - pc.x) > 90) {
    chaser = nearestChar(teams.player.filter((c) => c !== pc), landing);
  }
  for (const c of teams.player) {
    if (c === pc) continue;
    const isChaser = c === chaser;
    moveToward(c, isChaser ? landing : c.homeX, ALLY_SPEED);
    applyCharPhysics(c, COURT_LEFT + CHAR_RADIUS, NET_X - NET_WIDTH / 2 - CHAR_RADIUS);
    if (!ball.held && c.hitCooldown === 0 && ball.x < NET_X && nearBall(c, 4)) {
      aiHit(c);
    }
  }
}

function nearBall(c, pad) {
  return Math.hypot(ball.x - c.x, ball.y - c.y) < CHAR_RADIUS + BALL_RADIUS + pad;
}

function nearestChar(list, x) {
  return list.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best));
}

function moveToward(c, targetX, speed) {
  if (Math.abs(c.x - targetX) > 4) {
    c.vx = c.x < targetX ? speed : -speed;
  } else {
    c.vx = 0;
  }
}

function predictLandingX(side) {
  if (ball.held) return null;
  let sx = ball.x, sy = ball.y, svx = ball.vx, svy = ball.vy;
  const g = gravity();
  for (let i = 0; i < 300; i++) {
    svy += g;
    sx += svx;
    sy += svy;
    if (sx - BALL_RADIUS < COURT_LEFT) { sx = COURT_LEFT + BALL_RADIUS; svx *= -1; }
    if (sx + BALL_RADIUS > COURT_RIGHT) { sx = COURT_RIGHT - BALL_RADIUS; svx *= -1; }
    if (sy + BALL_RADIUS >= GROUND_Y) break;
  }
  const onSide = side === 'player' ? sx < NET_X : sx > NET_X;
  if (!onSide) return null;
  if (side === 'player') return Math.max(COURT_LEFT + CHAR_RADIUS, Math.min(NET_X - NET_WIDTH / 2 - CHAR_RADIUS, sx));
  return Math.max(NET_X + NET_WIDTH / 2 + CHAR_RADIUS, Math.min(COURT_RIGHT - CHAR_RADIUS, sx));
}

function applyCharPhysics(c, minX, maxX) {
  c.x += c.vx;
  if (c.x < minX) c.x = minX;
  if (c.x > maxX) c.x = maxX;

  c.vy += CHAR_GRAVITY;
  c.y += c.vy;
  const standY = GROUND_Y - CHAR_RADIUS;
  if (c.y >= standY) {
    c.y = standY;
    c.vy = 0;
    c.onGround = true;
  }
  if (c.hitCooldown > 0) c.hitCooldown--;
}

// --- Hitting -------------------------------------------------
function performHit(c, mode) {
  const side = c.side;
  if (touches[side] >= MAX_TOUCHES) {
    awardPoint(opponent(side)); // オーバータッチ
    return;
  }
  touches[side]++;
  const dir = side === 'player' ? 1 : -1;
  const level = difficultyLevel();
  if (mode === 'toss') {
    ball.vx = dir * 2.5;
    ball.vy = -12 - level * 0.2;
  } else {
    // 相手コート内の狙い点に一定の滞空時間で届く初速を逆算する
    const T = 45 - level * 3;
    const g = gravity();
    const aimX = NET_X + dir * (120 + Math.random() * 220);
    ball.vx = (aimX - ball.x) / T;
    ball.vy = (GROUND_Y - BALL_RADIUS - ball.y - 0.5 * g * T * (T + 1)) / T;
    // ネット上端を確実に越えられる高さを保証する
    const n = Math.max(1, Math.abs(NET_X - ball.x) / Math.abs(ball.vx));
    const yAtNet = ball.y + ball.vy * n + 0.5 * g * n * (n + 1);
    const clearY = NET_TOP - 35;
    if (yAtNet > clearY) ball.vy = (clearY - ball.y - 0.5 * g * n * (n + 1)) / n;
  }
  c.hitCooldown = 12;
}

function aiHit(c) {
  // ネットから遠く、まだタッチ回数に余裕があればトスで前につなぐ
  const distToNet = Math.abs(c.x - NET_X);
  const mode = touches[c.side] < MAX_TOUCHES - 1 && distToNet > 170 ? 'toss' : 'over';
  performHit(c, mode);
}

// --- Ball physics -------------------------------------------------
function updateBall() {
  if (ball.held) return;

  ball.vy += gravity();
  ball.x += ball.vx;
  ball.y += ball.vy;

  // side walls
  if (ball.x - BALL_RADIUS < COURT_LEFT) {
    ball.x = COURT_LEFT + BALL_RADIUS;
    ball.vx *= -1;
  }
  if (ball.x + BALL_RADIUS > COURT_RIGHT) {
    ball.x = COURT_RIGHT - BALL_RADIUS;
    ball.vx *= -1;
  }

  // net collision
  const withinNetHeight = ball.y + BALL_RADIUS > NET_TOP;
  const nearNetX = ball.x + BALL_RADIUS > NET_X - NET_WIDTH / 2 && ball.x - BALL_RADIUS < NET_X + NET_WIDTH / 2;
  if (withinNetHeight && nearNetX) {
    if (ball.x < NET_X) {
      ball.x = NET_X - NET_WIDTH / 2 - BALL_RADIUS;
    } else {
      ball.x = NET_X + NET_WIDTH / 2 + BALL_RADIUS;
    }
    ball.vx *= -0.6;
  }

  // コートを越えたらそちら側のタッチ回数をリセット
  const sideNow = ball.x < NET_X ? 'player' : 'cpu';
  if (sideNow !== lastBallSide) {
    lastBallSide = sideNow;
    touches[sideNow] = 0;
  }

  // ground -> point
  if (ball.y + BALL_RADIUS >= GROUND_Y) {
    awardPoint(ball.x < NET_X ? 'cpu' : 'player');
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

// --- Main loop -------------------------------------------------
function update() {
  if (state !== STATE.PLAYING) return;

  updatePlayer();
  updateCpuTeam();
  updateAllies();

  if (ball.held) {
    serveTimer--;
    const server = teams[serveSide][0];
    ball.x = server.x;
    ball.y = GROUND_Y - CHAR_RADIUS - BALL_RADIUS - 40;
    if (serveTimer <= 0) launchServe();
  } else {
    updateBall();
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // sky/court background
  ctx.fillStyle = '#2f6b2f';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#255a25';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(W, GROUND_Y);
  ctx.stroke();

  // net
  ctx.fillStyle = '#dddddd';
  ctx.fillRect(NET_X - NET_WIDTH / 2, NET_TOP, NET_WIDTH, GROUND_Y - NET_TOP);

  if (state === STATE.TITLE) {
    drawTitle();
    return;
  }

  for (const c of teams.player) drawChar(c);
  for (const c of teams.cpu) drawChar(c);
  drawBall();
  drawScore();
  if (ball.held) drawServeLabel();

  if (state === STATE.GAMEOVER) drawGameOver();
}

function drawChar(c) {
  ctx.beginPath();
  ctx.arc(c.x, c.y, CHAR_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = c.color;
  ctx.fill();
  // 操作キャラの目印
  if (c === controlled()) {
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - CHAR_RADIUS - 8);
    ctx.lineTo(c.x - 7, c.y - CHAR_RADIUS - 20);
    ctx.lineTo(c.x + 7, c.y - CHAR_RADIUS - 20);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

function drawBall() {
  // shadow
  const shadowScale = Math.max(0.2, 1 - (GROUND_Y - ball.y) / 500);
  ctx.beginPath();
  ctx.ellipse(ball.x, GROUND_Y + 4, 14 * shadowScale, 5 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.stroke();
}

function drawScore() {
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${score.player}  -  ${score.cpu}`, W / 2, 50);
  ctx.font = '14px sans-serif';
  ctx.fillText('プレイヤー', W / 2 - 100, 50);
  ctx.fillText('CPU', W / 2 + 90, 50);

  // 現在ボールがある側のタッチ回数
  if (!ball.held) {
    ctx.font = '13px sans-serif';
    ctx.fillText(`タッチ ${touches[lastBallSide]}/${MAX_TOUCHES}`, W / 2, 72);
  }
}

function drawServeLabel() {
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(serveSide === 'player' ? 'あなたのサーブ' : 'CPUのサーブ', W / 2, 100);
}

function drawTitle() {
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('ブラウザ・バレーボール 3 vs 3', W / 2, H / 2 - 80);
  ctx.font = '18px sans-serif';
  ctx.fillText('← → / A D : 移動    Space / ↑ : ジャンプ    Enter : 打つ', W / 2, H / 2 - 20);
  ctx.fillText('緑の▽が付いたキャラを操作。3回以内に相手コートへ返そう', W / 2, H / 2 + 10);
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
  update();
  draw();
  requestAnimationFrame(loop);
}

resetPositions();
loop();
