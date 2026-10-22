import assert from 'node:assert/strict';
import {findPath,clearSegment,recoverPosition} from '../src/world/navigation.js';
import {hitsWall} from '../src/world/scene.js';
import {COMP_TYPES} from '../src/game/competition-catalog.js';
const rooms=[[-3,3],[3,0],[-3,-6],[4,-6],[15,-6],[0,10]].map(([x,z])=>({x,z}));
let routes=0;
function check(a,b){
  const path=findPath(a,b);assert.ok(path.length,`No route ${JSON.stringify([a,b])}`);
  let last=a;for(const p of path){assert.ok(clearSegment(last,p),'Route cuts a wall/furniture corner');last=p;}
  assert.ok(Math.hypot(last.x-b.x,last.z-b.z)<.11,'Route misses a reachable destination');routes++;
}
for(const a of rooms)for(const b of rooms)check(a,b);
check({x:-10,z:5},{x:-1,z:5}); // sofa blocks the direct route
check({x:-8,z:2.5},{x:-3,z:2.5}); // coffee table
check({x:7,z:-6},{x:10,z:-10.8}); // HoH bed
const blocked={x:-6,z:2.5};recoverPosition(blocked);assert.equal(hitsWall(blocked.x,blocked.z),false);
const projected=findPath(rooms[0],{x:-6,z:2.5});assert.ok(projected.length);assert.equal(hitsWall(projected.at(-1).x,projected.at(-1).z),false);
assert.equal(COMP_TYPES.length,5);assert.equal(COMP_TYPES.includes('count'),false);
console.log(`PASS ${routes} collision-free house routes, embedded-body recovery, furniture destination projection, shared five-game roster`);
