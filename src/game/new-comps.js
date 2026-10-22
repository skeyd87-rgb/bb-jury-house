// Touch and keyboard accessible competitions. Timers stop when each game ends.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function stage(root, title, description) {
  const box = document.createElement('section'); box.className = 'comp-box comp-wide';
  const heading = document.createElement('h2'); heading.textContent = title;
  const desc = document.createElement('p'); desc.className = 'comp-desc'; desc.textContent = description;
  const status = document.createElement('p'); status.className = 'comp-status'; status.setAttribute('aria-live', 'polite');
  const board = document.createElement('div'); board.className = 'challenge-board';
  box.append(heading, desc, board, status); root.append(box);
  return { box, board, status };
}
function tile(label, action) {
  const b = document.createElement('button'); b.className = 'challenge-tile'; b.textContent = label; b.onclick = action; return b;
}

export function memoryComp(root) {
  return new Promise(resolve => {
    const {box, board, status} = stage(root, 'SIGNAL RECALL', 'Watch the numbered pads light up, then repeat the sequence. Four rounds.');
    let round = 0, answer = [], cursor = 0, total = 0, accepting = false, deadline;
    const pads = ['1 ◆', '2 ●', '3 ▲', '4 ■'].map((label, i) => tile(label, () => choose(i)));
    board.classList.add('memory-board'); board.append(...pads);
    const start = tile('Start sequence', next); box.append(start);
    async function next() {
      start.disabled = true; round++; cursor = 0; accepting = false;
      answer = Array.from({length:round + 2}, () => Math.floor(Math.random() * 4));
      pads.forEach(p => p.disabled = true); status.textContent = `Round ${round} of 4 · Watch`;
      await sleep(450);
      for (const id of answer) { pads[id].classList.add('lit'); await sleep(550); pads[id].classList.remove('lit'); await sleep(200); }
      pads.forEach(p => p.disabled = false); accepting = true; status.textContent = 'Your turn · repeat the sequence';
      deadline = setTimeout(() => complete(), 12000);
    }
    function choose(id) {
      if (!accepting) return;
      if (id !== answer[cursor]) { complete(); return; }
      cursor++; status.textContent = `${cursor} / ${answer.length} correct`;
      if (cursor === answer.length) complete();
    }
    function complete() {
      if (!accepting) return; accepting = false; clearTimeout(deadline); total += cursor / answer.length * 100;
      pads.forEach(p => p.disabled = true);
      status.textContent = `${cursor === answer.length ? 'Perfect recall!' : 'Sequence ended.'} ${cursor} of ${answer.length} correct.`;
      if (round === 4) { setTimeout(() => {box.remove(); resolve(Math.round(total / 4));}, 850); }
      else { start.textContent = 'Next sequence'; start.disabled = false; }
    }
  });
}

export function orderComp(root) {
  return new Promise(resolve => {
    const {box, board, status} = stage(root, 'STACK ORDER', 'Tap the values from LOWEST to HIGHEST. Three rounds, 12 seconds each. Wrong taps cost points.');
    let round = 0, values = [], index = 0, mistakes = 0, total = 0, accepting = false, timer, began;
    board.classList.add('order-board'); const start = tile('Start round', next); box.append(start);
    function next() {
      round++; index = 0; mistakes = 0; start.disabled = true; board.replaceChildren();
      values = [...new Set(Array.from({length:40}, () => 1 + Math.floor(Math.random() * 99)))].slice(0, 6).sort((a,b) => a-b);
      // Fisher-Yates keeps all board arrangements equally likely.
      const shuffled = [...values]; for(let i=shuffled.length-1;i>0;i--) {const j=Math.floor(Math.random()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
      shuffled.forEach(v => { const b = tile(String(v), () => {
        if(!accepting) return;
        if(v === values[index]) { b.disabled = true; b.classList.add('solved'); index++; if(index === values.length) finish(); }
        else { mistakes++; b.classList.add('wrong'); setTimeout(() => b.classList.remove('wrong'), 250); }
      }); board.append(b); });
      began = performance.now(); accepting = true; tick(); timer = setInterval(tick,100);
    }
    function tick() { const left=Math.max(0,12-(performance.now()-began)/1000); status.textContent=`Round ${round} of 3 · ${left.toFixed(1)}s · ${mistakes} errors`; if(left<=0) finish(); }
    function finish() {
      if(!accepting) return; accepting=false; clearInterval(timer);
      const elapsed=(performance.now()-began)/1000;
      const score=Math.max(0,Math.min(100,index/values.length*80+(index===values.length?Math.max(0,20-elapsed):0)-mistakes*8)); total+=score;
      board.querySelectorAll('button').forEach(b=>b.disabled=true); status.textContent=`${index} of ${values.length} sorted · ${Math.round(score)} points`;
      if(round===3) setTimeout(()=>{box.remove();resolve(Math.round(total/3));},850);
      else {start.textContent='Next round';start.disabled=false;}
    }
  });
}

export function circuitComp(root) {
  return new Promise(resolve => {
    const {box,board,status}=stage(root,'POWER GRID','Light every panel. Each switch flips itself and its up/down/left/right neighbors. Solve it within 40 seconds.');
    board.classList.add('circuit-board'); let cells=Array(9).fill(true), moves=0, active=false, began, timer;
    function flip(i) { const x=i%3,y=Math.floor(i/3); for(const [dx,dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {const nx=x+dx,ny=y+dy;if(nx>=0&&nx<3&&ny>=0&&ny<3)cells[ny*3+nx]=!cells[ny*3+nx];} }
    // Scramble a solved board through legal moves, guaranteeing a solution.
    const switches=[...Array(9).keys()]; for(let i=8;i>0;i--){const j=Math.floor(Math.random()*(i+1));[switches[i],switches[j]]=[switches[j],switches[i]];}
    switches.slice(0,5).forEach(flip);
    const buttons=cells.map((_,i)=>tile('',()=>{if(!active)return;flip(i);moves++;paint();if(cells.every(Boolean))finish(true);})); board.append(...buttons);
    const start=tile('Power on',()=>{start.disabled=true;active=true;began=performance.now();paint();timer=setInterval(()=>{const left=Math.max(0,40-(performance.now()-began)/1000);status.textContent=`${left.toFixed(0)}s · ${moves} switches`;if(!left)finish(false);},100);}); box.append(start);
    function paint(){buttons.forEach((b,i)=>{b.textContent=cells[i]?'ON':'OFF';b.classList.toggle('lit',cells[i]);b.disabled=!active;b.setAttribute('aria-label',`Panel ${i+1}, ${cells[i]?'on':'off'}`);});}
    function finish(solved){if(!active)return;active=false;clearInterval(timer);paint();const elapsed=(performance.now()-began)/1000;const score=solved?Math.max(70,100-Math.max(0,moves-5)*2-elapsed*.25):Math.round(cells.filter(Boolean).length/9*55);status.textContent=solved?'Grid restored!': 'Time up';setTimeout(()=>{box.remove();resolve(Math.round(score));},850);}
    paint();status.textContent='Study the grid, then power on.';
  });
}
