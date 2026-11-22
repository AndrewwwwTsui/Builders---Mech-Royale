import {run, type Action, type Vec2} from "./mechfight.ts"

const priorities = ["armor", "gun_rate", "gun_damage", "sensors"]
const distance = (a: number[], b: number[]) => Math.hypot(a[0]-b[0], a[1]-b[1])
const angleError = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a-b), Math.cos(a-b)))

run(hello => {
  let stalledSince = 0
  let jetUntil = 0
  return {
  name: "Dragon Shift 2",
  act(obs) {
    const {self, zone} = obs
    const [x,y,z] = self.pos
    const nearest = <T extends {pos: number[]}>(items: T[]) =>
      items.reduce<T | undefined>((best,item) =>
        !best || distance(item.pos,self.pos) < distance(best.pos,self.pos) ? item : best, undefined)
    const enemy = nearest(obs.mechs.filter(actor => actor.kind === "mech"))
    const secondary = self.weapons[1]
    const pickup = nearest(obs.pickups.filter(item => item.kind === "lightning" || (!secondary && item.kind === "laser")))
    const crate = nearest(obs.crates)
    const cube = nearest(obs.cubes)
    const target = enemy ?? crate
    // Keep enough travel time in reserve to reach the next circle.
    const excess = Math.max(0, distance(self.pos,zone.next_center)-Math.max(0,zone.next_radius-8))
    const retreat = !self.in_zone || (excess>0 && zone.shrink_end-obs.t < excess/7+12)
    const drop = nearest(obs.drops.filter(d=>d.lands_in<8 && distance(d.pos,self.pos)<105))
    const reachable = (item: {pos:number[]}, radius:number) =>
      distance(item.pos,self.pos)<radius && Math.abs(item.pos[2]-z)<8
    let goal: number[] = zone.next_center
    if (!retreat) {
      if (drop && (self.hp<self.max_hp*0.82 || !enemy)) goal = drop.pos
      else if (cube && reachable(cube,enemy ? 18 : 65)) goal = cube.pos
      else if (pickup && secondary?.kind !== "lightning" && reachable(pickup,enemy ? 24 : 90)) goal = pickup.pos
      else if (target) goal = target.pos
    }
    let dx = goal[0]-x, dy = goal[1]-y
    const capturing = drop && goal===drop.pos && Math.hypot(dx,dy)<drop.radius*0.6
    if (capturing) { dx=0; dy=0 }
    if (enemy && goal === enemy.pos) {
      const range = Math.hypot(dx,dy)
      const advance = Math.max(-1,Math.min(1,(range-(secondary?.kind === "lightning" ? 30 : 65))/20))
      const side = Math.floor(obs.t/2.7)%2 ? 1 : -1
      ;[dx,dy] = [advance*dx-side*dy,advance*dy+side*dx]
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
      const vx = enemy?.vel[0] ?? 0, vy = enemy?.vel[1] ?? 0
      const tx = target.pos[0]-x+vx*lead, ty = target.pos[1]-y+vy*lead
      const aim: Vec2 = [Math.atan2(ty,tx), Math.atan2(target.pos[2]+(enemy ? 4.5*(1+0.05*(enemy.cubes ?? 0)) : 1)-z-self.stats.muzzle_height,Math.hypot(tx,ty))]
      action.aim = aim
      const aligned = angleError(aim[0],self.aim[0])<0.18
      action.fire = [aligned,secondary?.kind==="laser" ? !(laserReady && aligned) : aligned && range<44]
    } else {
      const sound = nearestSound()
      action.aim = [sound?.bearing ?? obs.t*1.5,0]
      action.reload = (self.weapons[0]?.ammo ?? 12)<9
    }
    function nearestSound() { return obs.sounds.find(s=>s.dist==="near") ?? obs.sounds[0] }
    if (pickup && secondary?.kind!==pickup.kind && distance(pickup.pos,self.pos)<hello.config.loot.pickup_radius && Math.abs(pickup.pos[2]-z)<4) {
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
