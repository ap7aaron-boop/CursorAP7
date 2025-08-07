/* Cactus Runner - Chrome Dino–style endless runner */
(function(){
  'use strict';

  // DOM ------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const bestLabel = document.getElementById('bestLabel');
  const muteBtn = document.getElementById('muteBtn');
  const bannerPause = document.getElementById('bannerPause');
  const bannerGameOver = document.getElementById('bannerGameOver');

  // DPR ------------------------------------------------------
  const CSS_WIDTH = 720;
  const CSS_HEIGHT = 300;
  function applyDpr(){
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.style.width = CSS_WIDTH + 'px';
    canvas.style.height = CSS_HEIGHT + 'px';
    canvas.width = Math.floor(CSS_WIDTH * dpr);
    canvas.height = Math.floor(CSS_HEIGHT * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0); // scale logical pixels
  }
  applyDpr();
  window.addEventListener('resize', applyDpr);

  // Constants -----------------------------------------------
  const groundY = CSS_HEIGHT - 60;
  const gravity = 2400; // px/s^2
  const initialJumpVY = -780; // px/s
  const extraJumpAccel = -gravity * 0.45;
  const maxHoldJumpSec = 0.12;
  const minSpeed = 320; // px/s
  const maxSpeed = 560; // px/s
  const accelPerSec = 16; // small acceleration
  const spawnBaseMin = 0.65; // base spawn time at min speed
  const spawnBaseMax = 1.15;
  const clampDt = 1/20; // 50ms

  // World state ---------------------------------------------
  const state = {
    running: true,
    paused: false,
    gameOver: false,
    muted: false,
    time: 0,
    dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
    worldX: 0,
    speed: minSpeed,
    score: 0,
    best: Number(localStorage.getItem('cactusRunnerBest')||0),
    nextSpawnT: 0,
    entities: [], // obstacles + birds
    // player
    player: {
      x: 90,
      y: groundY,
      vx: 0,
      vy: 0,
      width: 46,
      height: 92,
      ducking: false,
      grounded: true,
      jumpHeld: false,
      jumpHoldTime: 0,
      animTime: 0,
      hit: false,
      sprite: 'run', // 'run'|'jump'|'duck'|'hit'
      facing: 1
    }
  };
  bestLabel.textContent = `Best: ${String(state.best).padStart(5,'0')}`;

  // Spritesheet generation ----------------------------------
  // Create a procedural shaded cactus character with cowboy hat
  const sprite = createCactusSprites();

  // Audio ----------------------------------------------------
  let audioCtx = null;
  let audioReady = false;
  function ensureAudio(){
    if(state.muted) return;
    if(audioCtx && audioCtx.state === 'running'){ audioReady = true; return; }
    if(!audioCtx){
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e){ console.warn('WebAudio unsupported'); return; }
    }
    if(audioCtx.state === 'suspended'){
      audioCtx.resume().then(()=>{ audioReady = true; }).catch(()=>{});
    } else { audioReady = true; }
  }
  function beep({type='square', freq=440, duration=0.08, volume=0.15, when=0}){
    if(state.muted) return;
    ensureAudio();
    if(!audioCtx || !audioReady) return;
    const t = audioCtx.currentTime + when;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = volume;
    o.connect(g).connect(audioCtx.destination);
    const attack = 0.005;
    const decay = Math.max(0, duration - attack);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t+attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t+attack+decay);
    o.start(t);
    o.stop(t+attack+decay+0.02);
  }
  const sfx = {
    jump(){ beep({type:'square', freq:620, duration:0.12, volume:0.18}); },
    score(){ beep({type:'triangle', freq:880, duration:0.09, volume:0.17}); },
    hit(){
      beep({type:'sine', freq:220, duration:0.12, volume:0.22});
      beep({type:'sine', freq:160, duration:0.16, volume:0.2, when:0.08});
    }
  };

  // Input ----------------------------------------------------
  const heldKeys = new Set();
  function onKeyDown(e){
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    heldKeys.add(e.code);

    switch(e.code){
      case 'KeyW': case 'ArrowUp': case 'Space':
        startJump(); ensureAudio(); break;
      case 'ArrowDown': case 'KeyS':
        startDuck(); break;
      case 'KeyP':
        togglePause(); break;
      case 'Enter':
        if(state.gameOver) restart(); break;
    }
  }
  function onKeyUp(e){
    heldKeys.delete(e.code);
    switch(e.code){
      case 'KeyW': case 'ArrowUp': case 'Space':
        endJump(); break;
      case 'ArrowDown': case 'KeyS':
        endDuck(); break;
    }
  }
  function onPointerDown(){ startJump(); ensureAudio(); if(state.gameOver) restart(); }
  function onPointerUp(){ endJump(); }

  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', (e)=>{ e.preventDefault(); onPointerDown(); }, {passive:false});
  canvas.addEventListener('touchend', (e)=>{ e.preventDefault(); onPointerUp(); }, {passive:false});
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  muteBtn.addEventListener('click', ()=>{
    state.muted = !state.muted;
    muteBtn.textContent = state.muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-pressed', String(state.muted));
    if(!state.muted) ensureAudio();
  });

  window.addEventListener('beforeunload', ()=>{
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('mousedown', onPointerDown);
    canvas.removeEventListener('mouseup', onPointerUp);
    canvas.removeEventListener('touchstart', onPointerDown);
    canvas.removeEventListener('touchend', onPointerUp);
  });

  // Player control ------------------------------------------
  function startJump(){
    if(state.paused || state.gameOver) return;
    const p = state.player;
    if(p.grounded){
      p.vy = initialJumpVY;
      p.grounded = false;
      p.jumpHeld = true;
      p.jumpHoldTime = 0;
      p.sprite = 'jump';
      sfx.jump();
    } else {
      p.jumpHeld = true; // variable jump while airborne and within hold window
    }
  }
  function endJump(){ state.player.jumpHeld = false; }
  function startDuck(){
    if(state.paused || state.gameOver) return;
    const p = state.player;
    if(p.grounded){ p.ducking = true; p.sprite = 'duck'; }
  }
  function endDuck(){
    const p = state.player;
    p.ducking = false;
    if(p.grounded) p.sprite = 'run';
  }
  function togglePause(){
    if(state.gameOver) return;
    state.paused = !state.paused;
    bannerPause.style.display = state.paused ? 'block' : 'none';
  }
  function restart(){
    state.entities.length = 0;
    state.speed = minSpeed;
    state.score = 0;
    state.worldX = 0;
    state.time = 0;
    state.nextSpawnT = 0;
    state.gameOver = false;
    state.paused = false;
    bannerGameOver.style.display = 'none';
    bannerPause.style.display = 'none';
    const p = state.player;
    p.x = 90; p.y = groundY; p.vx = 0; p.vy = 0; p.grounded = true; p.ducking = false; p.sprite = 'run'; p.hit=false; p.animTime=0;
  }

  // Entities -------------------------------------------------
  function spawnObstacle(){
    // Randomly choose between cactus cluster or bird
    const r = Math.random();
    if(r < 0.6){
      const count = 1 + (Math.random()*3|0); // 1-3
      const scale = Math.random() < 0.5 ? 1.0 : 1.2; // two sizes
      const widthPer = 28*scale;
      let w = count * widthPer + (count-1)*6*scale;
      const e = {
        type:'cactusCluster',
        x: CSS_WIDTH + 20,
        y: groundY,
        w,
        h: 60*scale,
        count,
        scale,
        scored: false
      };
      state.entities.push(e);
    } else {
      const heights = [groundY-110, groundY-70, groundY-30];
      const y = heights[(Math.random()*heights.length)|0];
      const bob = Math.random() < 0.5 ? {amp:12+Math.random()*10, speed: (Math.random()<0.5?-1:1)*60} : null; // px/s amplitude and directional bob speed
      const color = ['#2c3e50','#b33939','#2ecc71'][(Math.random()*3)|0];
      const e = {
        type:'bird',
        x: CSS_WIDTH + 20,
        y,
        baseY: y,
        w: 46,
        h: 34,
        bob,
        color,
        flapT: 0,
        scored: false
      };
      state.entities.push(e);
    }
  }

  function aabb(ax,ay,aw,ah,bx,by,bw,bh){
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // Update & Render -----------------------------------------
  let lastTime = performance.now();
  function loop(now){
    if(!state.running){ requestAnimationFrame(loop); return; }
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, clampDt);

    if(!state.paused && !state.gameOver){
      update(dt);
    }
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function update(dt){
    state.time += dt;
    state.speed = Math.min(maxSpeed, state.speed + accelPerSec*dt);
    state.worldX += state.speed * dt;

    // spawn cadence scales inversely with speed
    state.nextSpawnT -= dt;
    if(state.nextSpawnT <= 0){
      const t = lerp(spawnBaseMax, spawnBaseMin, (state.speed-minSpeed)/(maxSpeed-minSpeed));
      state.nextSpawnT = t * (0.75 + Math.random()*0.5);
      spawnObstacle();
    }

    // player physics
    const p = state.player;
    p.animTime += dt;
    if(!p.grounded){
      // variable jump
      if(p.jumpHeld && p.jumpHoldTime < maxHoldJumpSec){
        const can = Math.min(maxHoldJumpSec - p.jumpHoldTime, dt);
        p.vy += extraJumpAccel * can;
        p.jumpHoldTime += can;
      }
      p.vy += gravity * dt;
      p.y += p.vy * dt;
      if(p.y >= groundY){
        p.y = groundY;
        p.vy = 0;
        p.grounded = true;
        p.sprite = p.ducking ? 'duck' : 'run';
      }
    }

    // Update entities
    for(let i=state.entities.length-1;i>=0;i--){
      const e = state.entities[i];
      e.x -= state.speed * dt;
      if(e.type==='bird' && e.bob){
        e.flapT += dt*9;
        // vertical bob: max vertical speed ±60 px/s -> omega = 60/amp
        const omega = 60 / e.bob.amp; // rad/s approximation
        e.y = e.baseY + Math.sin(state.time * omega) * e.bob.amp;
      }
      if(!e.scored && e.x + e.w < 0){
        e.scored = true;
        state.score += 1;
        if(state.score % 5 === 0) sfx.score();
      }
      if(e.x + e.w < -40){
        state.entities.splice(i,1);
        continue;
      }
    }

    // Collision
    const pr = getPlayerRect();
    for(const e of state.entities){
      if(aabb(pr.x, pr.y, pr.w, pr.h, e.x, e.y - e.h, e.w, e.h)){
        // Hit
        sfx.hit();
        state.gameOver = true;
        state.paused = false;
        bannerGameOver.style.display = 'block';
        const pBest = Math.max(state.best, state.score);
        if(pBest !== state.best){
          state.best = pBest;
          localStorage.setItem('cactusRunnerBest', String(state.best));
          bestLabel.textContent = `Best: ${String(state.best).padStart(5,'0')}`;
        }
        break;
      }
    }
  }

  function getPlayerRect(){
    const p = state.player;
    const w = p.ducking ? 68 : 46;
    const h = p.ducking ? 58 : 92;
    const x = p.x - w/2;
    const y = p.y - h; // y is baseline at feet
    return {x,y,w,h};
  }

  function render(){
    // background gradient desert-day
    const w = CSS_WIDTH, h = CSS_HEIGHT;
    const g = ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'#e7efcc');
    g.addColorStop(0.6,'#d6e7a5');
    g.addColorStop(1,'#d1c58f');
    ctx.fillStyle = g;
    ctx.fillRect(0,0,w,h);

    // parallax distant hills
    drawHills();

    // ground strips
    drawGround();

    // entities
    for(const e of state.entities){
      if(e.type==='cactusCluster') drawCactusCluster(e);
      else drawBird(e);
    }

    // player
    drawPlayer();

    // HUD: score top-right
    ctx.save();
    ctx.font = 'bold 28px Nunito, system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#102a43';
    ctx.fillText(String(state.score).padStart(5,'0'), w-14, 8);
    ctx.restore();
  }

  function drawHills(){
    const w = CSS_WIDTH, h = CSS_HEIGHT;
    const x = - (state.worldX * 0.2 % (w+200));
    ctx.fillStyle = '#a0c37a';
    for(let i=0;i<3;i++){
      const baseX = x + i*(w+200);
      ctx.beginPath();
      ctx.moveTo(baseX-100, h-120);
      ctx.quadraticCurveTo(baseX+120, h-180, baseX+360, h-120);
      ctx.lineTo(baseX+360, h);
      ctx.lineTo(baseX-100, h);
      ctx.closePath();
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawGround(){
    const w = CSS_WIDTH, h = CSS_HEIGHT;
    // main ground strip
    ctx.fillStyle = '#a98f56';
    ctx.fillRect(0, groundY, w, h-groundY);

    // parallax ground lines
    const offset = state.worldX * 1.0;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for(let i=0;i<Math.ceil(w/22)+3;i++){
      const x = Math.floor(w - ((offset/2) % 22) - i*22);
      ctx.fillRect(x, groundY-2, 12, 2);
      ctx.fillRect(x+8, groundY+8, 10, 2);
      ctx.fillRect(x-10, groundY+16, 16, 2);
    }
  }

  function drawCactusCluster(e){
    let x = e.x;
    for(let i=0;i<e.count;i++){
      const type = i % 3; // rotate types
      drawEnemyCactus(x, e.y, e.scale, type);
      x += 28*e.scale + 6*e.scale;
    }
  }

  function drawEnemyCactus(x, baseY, scale, type){
    // type 0: regular, 1: taller, 2: wider
    const s = scale;
    const bodyH = [44, 56, 40][type] * s;
    const bodyW = [18, 16, 24][type] * s;
    const y = baseY;
    const col = ['#2e9c3a','#2b8d35','#25852f'][type];
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = col;
    ctx.strokeStyle = '#0e4e1a';
    ctx.lineWidth = 2;
    // stem
    roundRectPath(-bodyW/2, -bodyH, bodyW, bodyH, 4*s);
    ctx.fill();
    // arms
    const armH = 18*s;
    const armW = 10*s;
    // left
    roundRectPath(-bodyW/2 - armW + 2*s, -bodyH*0.45, armW, armH, 4*s); ctx.fill();
    roundRectPath(-bodyW/2 - armW + 2*s, -bodyH*0.45 + armH-6*s, armW+6*s, 8*s, 4*s); ctx.fill();
    // right
    roundRectPath(bodyW/2 - 2*s, -bodyH*0.3, armW, armH, 4*s); ctx.fill();
    roundRectPath(bodyW/2 - 2*s - 6*s, -bodyH*0.3 + armH-6*s, armW+6*s, 8*s, 4*s); ctx.fill();
    // shade dots
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for(let i=0;i<4;i++) ctx.fillRect(-2*s, -bodyH + 8*s + i*12*s, 4*s, 6*s);
    ctx.restore();
  }

  function drawBird(e){
    const x = e.x, y = e.y;
    ctx.save();
    ctx.translate(x, y);
    // body
    ctx.fillStyle = e.color;
    roundRectPath(-20, -16, 40, 24, 8);
    ctx.fill();
    // wing (flapping)
    const flap = Math.sin(e.flapT*6) * 10;
    ctx.save();
    ctx.translate(-6, -4);
    ctx.rotate(-0.2);
    roundRectPath(-14, -6+flap*0.1, 26, 12, 6); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
    ctx.restore();
    // head
    roundRectPath(12, -18, 18, 16, 6); ctx.fillStyle = e.color; ctx.fill();
    // beak
    ctx.fillStyle = '#f6ae2d';
    ctx.beginPath(); ctx.moveTo(30, -10); ctx.lineTo(40, -6); ctx.lineTo(30, -2); ctx.closePath(); ctx.fill();
    // eye
    ctx.fillStyle = '#111'; ctx.fillRect(22, -8, 3, 3);
    ctx.restore();
  }

  function drawPlayer(){
    const p = state.player;
    const frame = getPlayerFrame(p);
    // draw using spritesheet
    const sx = frame.sx, sy = frame.sy, sw = sprite.fw, sh = sprite.fh;
    const dw = frame.dw, dh = frame.dh;
    const dx = p.x - dw/2;
    const dy = p.y - dh;
    ctx.drawImage(sprite.canvas, sx, sy, sw, sh, dx, dy, dw, dh);

    // optional debug AABB
    // const r = getPlayerRect(); ctx.strokeStyle='rgba(255,0,0,0.4)'; ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  function getPlayerFrame(p){
    const scale = 1;
    const runFrames = sprite.maps.run;
    const duckFrames = sprite.maps.duck;
    const jumpFrames = sprite.maps.jump;
    const hitFrames = sprite.maps.hit;
    if(state.gameOver){ return frameInfo(hitFrames[0], 64, 100); }
    if(p.sprite==='duck' && p.grounded){
      const idx = Math.floor(p.animTime*10)%duckFrames.length; return frameInfo(duckFrames[idx], 90, 62);
    }
    if(!p.grounded){
      const idx = Math.min(jumpFrames.length-1, Math.floor(p.animTime*12)%jumpFrames.length); return frameInfo(jumpFrames[idx], 70, 96);
    }
    // running
    const idx = Math.floor(p.animTime*12)%runFrames.length; return frameInfo(runFrames[idx], 70, 96);

    function frameInfo(idx, dw, dh){
      const sx = (idx % sprite.cols) * sprite.fw;
      const sy = Math.floor(idx / sprite.cols) * sprite.fh;
      return {sx, sy, dw, dh};
    }
  }

  // Utilities -----------------------------------------------
  function lerp(a,b,t){ return a + (b-a)*t; }
  function roundRectPath(x,y,w,h,r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  // Procedural spritesheet ----------------------------------
  function createCactusSprites(){
    const fw = 96, fh = 120; // frame size
    const cols = 6; // grid layout
    const runN = 6, jumpN = 4, duckN = 4, hitN = 1;
    const total = runN + jumpN + duckN + hitN;
    const rows = Math.ceil(total / cols);
    const can = document.createElement('canvas');
    can.width = cols * fw;
    can.height = rows * fh;
    const c = can.getContext('2d');

    // helper to draw single frame
    function drawFrame(ix, draw){
      const col = ix % cols;
      const row = Math.floor(ix / cols);
      const ox = col * fw;
      const oy = row * fh;
      c.save();
      c.translate(ox + fw/2, oy + fh);
      draw(c);
      c.restore();
    }

    const green = '#43c156';
    const greenDark = '#2a7a39';
    const greenLight = '#6fe07d';

    function drawCactusCharacter(gc, pose){
      // pose contains: squash (0..1), armsAngL, armsAngR, yOffset, duck
      const duck = !!pose.duck;
      const scaleY = duck ? 0.72 : 1.0;
      const scaleX = duck ? 1.15 : 1.0;
      gc.save();
      gc.scale(scaleX, scaleY);
      gc.translate(0, -4);
      // body
      const bodyW = 42, bodyH = 96;
      const r = 10;
      pathRoundRect(gc, -bodyW/2, -bodyH, bodyW, bodyH, r);
      gc.fillStyle = green;
      gc.fill();
      // stripes
      gc.fillStyle = greenLight;
      for(let i=0;i<6;i++) gc.fillRect(-3, -bodyH+14+i*16, 6, 10);
      // shadow edge
      gc.strokeStyle = greenDark; gc.lineWidth = 3; pathRoundRect(gc, -bodyW/2, -bodyH, bodyW, bodyH, r); gc.stroke();
      // arms
      gc.fillStyle = green;
      drawArm(gc, -bodyW/2, -bodyH*0.45, -1, pose.armsAngL||0);
      drawArm(gc, bodyW/2, -bodyH*0.35, 1, pose.armsAngR||0);
      // face
      drawFace(gc, duck);
      // cowboy hat
      drawHat(gc, duck);
      gc.restore();
    }

    function drawArm(gc, ox, oy, dir, ang){
      gc.save();
      gc.translate(ox, oy);
      gc.rotate(ang*dir);
      pathRoundRect(gc, dir<0?-18:0, 0, 18, 28, 8);
      gc.fill();
      pathRoundRect(gc, dir<0?-24:0, 22, 24, 10, 6);
      gc.fill();
      gc.restore();
    }
    function drawFace(gc, duck){
      gc.save();
      gc.translate(0, -72*(duck?0.85:1));
      // eyes
      gc.fillStyle = '#0e0e0e';
      gc.fillRect(-10, -6, 4, 6);
      gc.fillRect(6, -6, 4, 6);
      // smile
      gc.fillRect(-6, 6, 12, 3);
      gc.restore();
    }
    function drawHat(gc, duck){
      gc.save();
      gc.translate(0, -96*(duck?0.85:1) - 8);
      gc.fillStyle = '#6b4f2a';
      pathRoundRect(gc, -28, -6, 56, 12, 6); gc.fill();
      pathRoundRect(gc, -14, -20, 28, 16, 6); gc.fill();
      gc.restore();
    }
    function pathRoundRect(gc,x,y,w,h,r){
      const rr = Math.min(r,w/2,h/2);
      gc.beginPath();
      gc.moveTo(x+rr,y);
      gc.arcTo(x+w,y,x+w,y+h,rr);
      gc.arcTo(x+w,y+h,x,y+h,rr);
      gc.arcTo(x,y+h,x,y,rr);
      gc.arcTo(x,y,x+w,y,rr);
      gc.closePath();
    }

    // Running frames
    for(let i=0;i<runN;i++){
      drawFrame(i, (gc)=>{
        const ang = Math.sin((i/runN)*Math.PI*2)*0.5;
        drawCactusCharacter(gc, {armsAngL: 0.6+ang*0.4, armsAngR: -0.6+ang*0.4, duck:false});
      });
    }
    // Jump frames
    for(let i=0;i<jumpN;i++){
      drawFrame(runN+i, (gc)=>{
        const ang = 0.1 + i*0.05;
        drawCactusCharacter(gc, {armsAngL: 0.8+ang, armsAngR: -0.8-ang, duck:false});
      });
    }
    // Duck frames
    for(let i=0;i<duckN;i++){
      drawFrame(runN+jumpN+i, (gc)=>{
        const ang = Math.sin((i/duckN)*Math.PI*2)*0.2;
        drawCactusCharacter(gc, {armsAngL: 0.2+ang, armsAngR: -0.2-ang, duck:true});
      });
    }
    // Hit frame
    drawFrame(runN+jumpN+duckN, (gc)=>{
      drawCactusCharacter(gc, {armsAngL: -0.1, armsAngR: 0.1, duck:false});
      gc.save();
      gc.fillStyle = 'rgba(0,0,0,0.25)';
      gc.translate(0,-70); gc.rotate(-0.1);
      gc.fillRect(-18, -2, 36, 4);
      gc.restore();
    });

    return {
      canvas: can,
      fw, fh, cols,
      maps: {
        run: Array.from({length:runN}, (_,i)=>i),
        jump: Array.from({length:jumpN}, (_,i)=>runN+i),
        duck: Array.from({length:duckN}, (_,i)=>runN+jumpN+i),
        hit: [runN+jumpN+duckN]
      }
    };
  }

})();