import {readFileSync} from "node:fs"
import {join} from "node:path"
import {run, type Action, type Vec2} from "./mechfight.ts"

const priorities = ["plating", "gun_damage", "armor", "gun_rate", "laser_damage", "gun_mag", "servos", "nanites", "sensors"]
const distance = (a: number[], b: number[]) => Math.hypot(a[0]-b[0], a[1]-b[1])
const angleError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a-b), Math.cos(a-b)))

type Prism = {base:number, top:number, ring:number[], holes:number[][]}

function inside(x:number, y:number, ring:number[]) {
  let hit=false
  for (let i=0,j=ring.length-2; i<ring.length; j=i,i+=2) {
    const ax=ring[i], ay=ring[i+1], bx=ring[j], by=ring[j+1]
    if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) hit=!hit
  }
  return hit
}

// Index arena geometry once so each movement probe checks only nearby shapes.
function arenaWalls(dir:string) {
  const cells=new Map<string,Prism[]>()
  const cell=(n:number)=>Math.floor(n/32)
  const world=JSON.parse(readFileSync(join(dir,"v2/world.json"),"utf8"))
  for (const p of world.prisms as Prism[]) {
    const xs=p.ring.filter((_,i)=>i%2===0), ys=p.ring.filter((_,i)=>i%2===1)
    for(let i=cell(Math.min(...xs));i<=cell(Math.max(...xs));i++) {
      for(let j=cell(Math.min(...ys));j<=cell(Math.max(...ys));j++) {
        const key=i+","+j
        if(!cells.has(key)) cells.set(key,[])
        cells.get(key)!.push(p)
      }
    }
  }
  return (x:number,y:number,z:number) => (cells.get(cell(x)+","+cell(y)) ?? []).some(
    p=>z<p.top && z>p.base && inside(x,y,p.ring) && !p.holes.some(r=>inside(x,y,r)))
}

// Build a four-neighbor ground graph from the game's mounted map.
function groundRoutes(dir:string, wall:(x:number,y:number,z:number)=>boolean) {
  const world=JSON.parse(readFileSync(join(dir,"v2/world.json"),"utf8"))
  const t=world.terrain, b=world.bounds
  if (!t || !b) return
  const heights=readFileSync(join(dir,"v2",t.file))
  const ground=(x:number,y:number) => {
    const i=Math.max(0,Math.min(t.nx-1,Math.round((x-t.minX)/t.step)))
    const j=Math.max(0,Math.min(t.ny-1,Math.round((y-t.minY)/t.step)))
    return heights.readInt16LE(2*(j*t.nx+i))*t.scale
  }
  const step=5
  const cols=Math.floor((b.maxX-b.minX)/step)+1, rows=Math.floor((b.maxY-b.minY)/step)+1
  const count=cols*rows, free=new Uint8Array(count), elevations=new Float32Array(count)
  const point=(id:number):Vec2=>[b.minX+(id%cols)*step,b.minY+Math.floor(id/cols)*step]
  const cell=(p:number[])=>Math.round((p[1]-b.minY)/step)*cols+Math.round((p[0]-b.minX)/step)
  for(let id=0;id<count;id++) {
    const [x,y]=point(id), z=ground(x,y)
    elevations[id]=z
    free[id]=Number(x>b.minX+3 && x<b.maxX-3 && y>b.minY+3 && y<b.maxY-3 &&
      [[0,0],[-3,-3],[3,3],[-3,3],[3,-3]].every(([dx,dy])=>
        !wall(x+dx,y+dy,z+1.4) && !wall(x+dx,y+dy,z+8)))
  }
  function nearCell(p:number[]) {
    const i=cell(p)
    if(free[i]) return i
    let best=-1, cost=12
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
      const id=i+dx+dy*cols
      if(!free[id]) continue
      const d=distance(p,point(id))
      if(d<cost) { best=id; cost=d }
    }
    return best
  }
  const parent=new Int32Array(count), queue=new Int32Array(count)
  const directions=[-cols,1,cols,-1]
  let destination=-1, lastBuild=-Infinity
  return function waypoint(from:number[],to:number[],now:number):Vec2|undefined {
    if(Math.abs(from[2]-ground(from[0],from[1]))>5 || distance(from,to)<14) return
    const segments=Math.ceil(distance(from,to)/3)
    let direct=true
    for(let i=1;i<=segments;i++){
      const x=from[0]+(to[0]-from[0])*i/segments, y=from[1]+(to[1]-from[1])*i/segments
      if(!free[cell([x,y])]) { direct=false; break }
    }
    if(direct) return
    const start=nearCell(from), end=nearCell(to)
    if(start<0 || end<0 || start===end) return
    if(end!==destination) {
      if(now-lastBuild<0.6) return
      destination=end; lastBuild=now
      parent.fill(-1); parent[end]=end; queue[0]=end
      let tail=1
      for(let head=0;head<tail;head++){
        const id=queue[head]
        for(const delta of directions){
          const n=id+delta
          if(!free[n] || parent[n]!==-1 || Math.abs(elevations[n]-elevations[id])>4.5) continue
          parent[n]=id; queue[tail++]=n
        }
      }
    }
    if(parent[start]<0) return
    // Look ahead only across clear cells, so a bend cannot shortcut through a wall.
    let cursor=start, best=parent[start]
    for(let j=0;j<14 && cursor!==end;j++){
      cursor=parent[cursor]
      const p=point(cursor), n=Math.max(1,Math.ceil(distance(from,p)/2))
      let clear=true
      for(let k=1;k<=n;k++){
        const x=from[0]+(p[0]-from[0])*k/n,y=from[1]+(p[1]-from[1])*k/n
        if(!free[cell([x,y])]) { clear=false; break }
      }
      if(!clear) break
      best=cursor
    }
    return point(best)
  }
}

run(hello => {
  const wall=arenaWalls(hello.map.dir)
  const route=groundRoutes(hello.map.dir,wall)
  let detourSide=1
  let detourUntil=0
  let recovering = false
  let patrolStep = 0
  let patrolGoal: Vec2 | undefined
  let patrolExpires = 0
  type Loot = {id:number, pos:[number,number,number], kind:string}
  const lootMemory = new Map<number,{item:Loot, seen:number}>()
  let focused=-1
  let stalledSince = 0
  let jetUntil = 0
  return {
  name: "Dragon Shift 8",
  act(obs) {
    const {self, zone} = obs
    const [x,y,z] = self.pos
    const nearest = <T extends {pos: number[]}>(items: T[]) =>
      items.reduce<T | undefined>((best,item) =>
        !best || distance(item.pos,self.pos) < distance(best.pos,self.pos) ? item : best, undefined)
    const clearTo = (pos:number[],height:number) => {
      const range=distance(pos,self.pos), muzzle=z+self.stats.muzzle_height
      const steps=Math.ceil(range/5)
      for(let i=1;i<steps;i++) {
        const f=i/steps
        if(wall(x+(pos[0]-x)*f,y+(pos[1]-y)*f,muzzle+(pos[2]+height-muzzle)*f)) return false
      }
      return true
    }
    const actors=obs.mechs.filter(a=>clearTo(a.pos,a.kind==="npc"?1.75:4.5))
    const enemy=actors.filter(a=>a.kind==="mech").sort((a,b)=>priority(a)-priority(b))[0]
    function priority(a:typeof actors[number]) {
      return distance(a.pos,self.pos)+65*(a.hp ?? 1400)/(a.max_hp || 1400)-(a.id===focused?18:0)
    }
    if(enemy) focused=enemy.id
    const drone=nearest(actors.filter(a=>a.kind==="npc" && distance(a.pos,self.pos)<115))
    const secondary=self.weapons[1]
    const rank=(kind:string)=>kind==="laser"?3:kind==="lightning"?2:0
    const visibleLoot: Loot[] = [
      ...obs.pickups,
      ...obs.cubes.map(c => ({id:c.id,pos:c.pos,kind:"cube"}))
    ]
    const visibleIds = new Set(visibleLoot.map(item=>item.id))
    for (const item of visibleLoot) lootMemory.set(item.id,{item,seen:obs.t})
    for (const [id,entry] of lootMemory) {
      const arrived = distance(entry.item.pos,self.pos)<5 && Math.abs(entry.item.pos[2]-z)<4
      if (obs.t-entry.seen>7 || (arrived && !visibleIds.has(id))) lootMemory.delete(id)
    }
    const crate=nearest(obs.crates.filter(c=>clearTo(c.pos,1.2)))
    // Dealing damage resets regeneration, including optional encounters.
    const healthFraction = self.hp / self.max_hp
    if (healthFraction < 0.55) recovering = true
    if (healthFraction >= 0.83) recovering = false
    const rest = recovering && self.in_zone && !enemy
    const actor = enemy ?? (rest ? undefined : drone)
    const target = actor ?? (rest ? undefined : crate)
    // Keep enough travel time in reserve to reach the next circle.
    const excess = Math.max(0, distance(self.pos,zone.next_center)-Math.max(0,zone.next_radius-8))
    const retreat = !self.in_zone || (excess>0 && zone.shrink_end-obs.t < excess/7+12)
    const walkSpeed = self.stats.walk_speed || 11.7
    // Reject optional destinations that will be outside the circle on arrival.
    function safeOnArrival(pos:number[], stopSeconds=0) {
      const arrival = obs.t + distance(pos,self.pos)/walkSpeed + stopSeconds
      const start = Math.max(obs.t,zone.shrink_start)
      const fraction = Math.max(0,Math.min(1,(arrival-start)/Math.max(0.1,zone.shrink_end-start)))
      const cx = zone.center[0]+fraction*(zone.next_center[0]-zone.center[0])
      const cy = zone.center[1]+fraction*(zone.next_center[1]-zone.center[1])
      const radius = zone.radius+fraction*(zone.next_radius-zone.radius)
      return Math.hypot(pos[0]-cx,pos[1]-cy) <= Math.max(0,radius-3)
    }
    const drop = nearest(obs.drops.filter(d => {
      const travel = distance(d.pos,self.pos)/walkSpeed
      return travel<14 && d.lands_in<travel+5 && safeOnArrival(d.pos,d.capture_s)
    }))
    const reachable = (item: {pos:number[]}, radius:number) =>
      distance(item.pos,self.pos)<radius && Math.abs(item.pos[2]-z)<8 && safeOnArrival(item.pos)
    const candidates = Array.from(lootMemory.values(),entry=>entry.item)
    const pickup=nearest(candidates.filter(p=>rank(p.kind)>rank(secondary?.kind ?? "") &&
      reachable(p,enemy ? 24 : 90)))
    const cube=nearest(candidates.filter(p=>p.kind==="cube" && reachable(p,enemy ? 18 : 65)))
    let goal: number[] = zone.next_center
    if (!retreat) {
      // Finish an active capture while its progress can still pay off.
      const canCapture = drop && (drop.holder===self.id || !enemy || healthFraction<0.82)
      if (canCapture) goal = drop.pos
      else if (cube) goal = cube.pos
      else if (pickup) goal = pickup.pos
      else if (target && safeOnArrival(target.pos)) goal = target.pos
      else if (!target && distance(self.pos,zone.next_center)<Math.max(18,zone.next_radius*0.55) && zone.next_radius>35) {
        // Explore new pickup locations when the center has already been searched.
        if (!patrolGoal || distance(patrolGoal,self.pos)<8 || obs.t>=patrolExpires || !safeOnArrival(patrolGoal)) {
          const angle = self.id+patrolStep++*2.39996
          const radius = Math.min(78,zone.next_radius*0.48)
          patrolGoal = [zone.next_center[0]+radius*Math.cos(angle),zone.next_center[1]+radius*Math.sin(angle)]
          patrolExpires = obs.t+12
        }
        goal = patrolGoal
      }
    }
    const navigating=goal!==enemy?.pos && goal!==drone?.pos
    const waypoint=navigating ? route?.(self.pos,goal,obs.t) : undefined
    const steeringGoal=waypoint ?? goal
    let dx = steeringGoal[0]-x, dy = steeringGoal[1]-y
    const capturing = drop && goal===drop.pos && Math.hypot(dx,dy)<drop.radius*0.6
    if (capturing) { dx=0; dy=0 }
    if (enemy && goal === enemy.pos) {
      const range = Math.hypot(dx,dy)
      const advance = Math.max(-1,Math.min(1,(range-(secondary?.kind === "lightning" ? 30 : 65))/20))
      const side = Math.floor(obs.t/2.7)%2 ? 1 : -1
      ;[dx,dy] = [advance*dx-side*dy,advance*dy+side*dx]
    }
    // Prefer the most direct open heading; keep the same side around a corner.
    const desired=Math.atan2(dy,dx)
    const side=obs.t<detourUntil ? detourSide : (self.id%2 ? -1 : 1)
    function openHeading(angle:number) {
      const ux=Math.cos(angle), uy=Math.sin(angle)
      for(const step of [3,7,12]) {
        for(const offset of [-2.1,0,2.1]) {
          const px=x+step*ux-offset*uy, py=y+step*uy+offset*ux
          if(wall(px,py,z+1.3) || wall(px,py,z+7)) return false
        }
      }
      return true
    }
    if(Math.hypot(dx,dy)>3 && !openHeading(desired)) {
      for(const turn of [0.45,-0.45,0.9,-0.9,1.4,-1.4,1.85,-1.85]) {
        const candidate=desired+turn*side
        if(openHeading(candidate)) {
          dx=12*Math.cos(candidate); dy=12*Math.sin(candidate)
          detourSide=side*Math.sign(turn); detourUntil=obs.t+1
          break
        }
      }
    }
    const length = Math.max(1,Math.hypot(dx,dy))
    // A short jump alone cannot clear buildings. Continue thrusting after takeoff.
    const forwardSpeed=(dx*self.vel[0]+dy*self.vel[1])/length
    if (length<4 || forwardSpeed>3 || !self.grounded) stalledSince=obs.t
    if (self.grounded && obs.t-stalledSince>0.65 && self.energy>35) {
      jetUntil=obs.t+Math.min(3.2,self.energy/22)
      stalledSince=obs.t
    }
    const climbing = obs.t<jetUntil
    const action: Omit<Action,"tick"> = {
      move:[dx/length,dy/length], boost: climbing || (retreat && self.energy>35),
      jump: climbing && self.grounded
    }
    if (target) {
      const range = distance(target.pos,self.pos)
      const laserReady = secondary?.kind==="laser" && (secondary.charge ?? 0)>=(secondary.stats.charge ?? 0.75)
      const lead = laserReady ? 0 : range/(self.weapons[0]?.stats.speed || 252)
      const vx = actor?.vel[0] ?? 0, vy = actor?.vel[1] ?? 0
      const tx = target.pos[0]-x+vx*lead, ty = target.pos[1]-y+vy*lead
      const aim: Vec2 = [Math.atan2(ty,tx), Math.atan2(target.pos[2]+(enemy ? 4.5*(1+0.05*(enemy.cubes ?? 0)) : drone ? 1.75 : 1.2)+(actor?.vel[2] ?? 0)*Math.min(lead,0.22)-z-self.stats.muzzle_height,Math.hypot(tx,ty))]
      action.aim = aim
      const aligned = angleError(aim[0],self.aim[0])<0.18
      action.fire = [aligned,secondary?.kind==="laser" ? !(laserReady && aligned) : aligned && range<44]
    } else {
      const sound = nearestSound()
      action.aim = [sound?.bearing ?? obs.t*1.5,0]
      action.reload = (self.weapons[0]?.ammo ?? 12)<9
    }
    function nearestSound() { return obs.sounds.find(s=>s.dist==="near") ?? obs.sounds[0] }
    if (pickup && visibleIds.has(pickup.id) && secondary?.kind!==pickup.kind && distance(pickup.pos,self.pos)<hello.config.loot.pickup_radius && Math.abs(pickup.pos[2]-z)<4) {
      action.take = pickup.id
      if (secondary) action.drop=1
    }
    if (obs.offer) {
      const choices = obs.offer.choices
      const preferred = priorities.map(id=>choices.findIndex(c=>c.id===id)).find(index=>index>=0)
      action.pick = preferred ?? 0
    }
    return action
  }
}})
