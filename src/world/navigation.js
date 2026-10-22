// Static walkability comes from the same walls/furniture used by collision.
// A* routes around obstacles within rooms as well as through doorways.
import { hitsWall } from './scene.js';
export const BOUNDS = { minX:-17, maxX:19.5, minZ:-11.5, maxZ:17.5 };
const CELL=.4, COLS=Math.floor((BOUNDS.maxX-BOUNDS.minX)/CELL)+1, ROWS=Math.floor((BOUNDS.maxZ-BOUNDS.minZ)/CELL)+1;
const point=id=>({x:BOUNDS.minX+(id%COLS)*CELL,z:BOUNDS.minZ+Math.floor(id/COLS)*CELL});
let grid;
function walkable(id){if(!grid)grid=Array.from({length:COLS*ROWS},(_,i)=>{const p=point(i);return !hitsWall(p.x,p.z,.48);});return id>=0&&id<grid.length&&grid[id];}
export function clearSegment(a,b) {
  const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.12));
  for(let i=0;i<=steps;i++){const t=i/steps;if(hitsWall(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t))return false;}return true;
}
function nearest(p, connect=false){
  let best=-1,dist=Infinity;
  for(let id=0;id<COLS*ROWS;id++) {if(!walkable(id))continue;const q=point(id),d=(p.x-q.x)**2+(p.z-q.z)**2;if(d<dist&&(!connect||clearSegment(p,q))){dist=d;best=id;}}
  return best;
}
export function recoverPosition(p){if(!hitsWall(p.x,p.z))return;const id=nearest(p);if(id>=0){const q=point(id);p.x=q.x;p.z=q.z;}}
export function findPath(from,to) {
  const end={x:Math.max(BOUNDS.minX,Math.min(BOUNDS.maxX,to.x)),z:Math.max(BOUNDS.minZ,Math.min(BOUNDS.maxZ,to.z))};
  if(clearSegment(from,end))return [end];
  const start=nearest(from,true),goal=nearest(end); if(start<0||goal<0)return [];
  const target=point(goal),open=[start],cost=new Map([[start,0]]),prev=new Map(),closed=new Set();
  const heuristic=id=>{const p=point(id);return Math.hypot(p.x-target.x,p.z-target.z);};
  while(open.length){
    let pick=0;for(let i=1;i<open.length;i++)if(cost.get(open[i])+heuristic(open[i])<cost.get(open[pick])+heuristic(open[pick]))pick=i;
    const id=open.splice(pick,1)[0];if(id===goal){
      const path=[point(id)];let at=id;while(prev.has(at)){at=prev.get(at);path.unshift(point(at));}
      if(!hitsWall(end.x,end.z)&&clearSegment(path.at(-1),end))path.push(end);
      const smooth=[];let anchor=from,index=0;
      while(index<path.length){let far=index;while(far+1<path.length&&clearSegment(anchor,path[far+1]))far++;smooth.push(path[far]);anchor=path[far];index=far+1;}return smooth;
    }
    closed.add(id); const x=id%COLS,y=Math.floor(id/COLS);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const nx=x+dx,ny=y+dy,nid=ny*COLS+nx;
      if(nx<0||nx>=COLS||ny<0||ny>=ROWS||!walkable(nid)||closed.has(nid))continue;
      if(dx&&dy&&(!walkable(y*COLS+nx)||!walkable(ny*COLS+x)))continue;
      const next=cost.get(id)+CELL*Math.hypot(dx,dy);if(next>=(cost.get(nid)??Infinity))continue;
      cost.set(nid,next);prev.set(nid,id);if(!open.includes(nid))open.push(nid);
    }
  }return [];
}

export function turnToward(obj,angle,dt){const delta=Math.atan2(Math.sin(angle-obj.rotation.y),Math.cos(angle-obj.rotation.y));obj.rotation.y+=delta*(1-Math.exp(-dt*12));}
