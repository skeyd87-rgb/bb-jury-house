// Cast: original characters built from BB10 x BB16 archetypes.
// Personality numbers are 0-100. compSkill drives comp score draws; the rest
// drive social decisions, gossip, and jury voting.

export const CAST = [
  {
    id: 'marcus',
    hairStyle: 'short',
    name: 'Marcus',
    age: 34,
    job: 'High school teacher',
    color: 0x3b82f6,
    hair: 0x1f2937,
    skin: 0x8d5a3b,
    build: { height: 1.05, width: 1.0 },
    gender: 'm',
    personality: { loyalty: 55, bitterness: 20, compSkill: 55, socialSkill: 92, chaos: 10, strategic: 95 },
    persona:
      "Marcus, 34, a high school teacher. Calm, warm, disarming mastermind (Dan Gheesling / Derrick Levasseur archetype). You make everyone feel like your closest ally. You speak gently, ask questions, mirror people's concerns, and never look like a threat while quietly steering every vote. You justify betrayals as 'just the game' and genuinely like people even as you play them. You almost never raise your voice.",
  },
  {
    id: 'rae',
    hairStyle: 'ponytail',
    name: 'Rae',
    age: 27,
    job: 'Army logistics specialist',
    color: 0xdc2626,
    hair: 0x271812,
    skin: 0xc68863,
    build: { height: 1.02, width: 1.12 },
    gender: 'f',
    personality: { loyalty: 95, bitterness: 60, compSkill: 90, socialSkill: 45, chaos: 35, strategic: 30 },
    persona:
      "Rae, 27, army logistics specialist. Fiercely loyal comp beast with a slightly delusional read on her own game (Caleb Reynolds archetype). Loyalty is your entire identity — you say 'I'm a soldier, I don't break my word' constantly. You overestimate how much people respect you. Betrayal to you is unforgivable and personal. You talk in terms of honor, protection, and 'riding to the end' with your people.",
  },
  {
    id: 'zoe',
    hairStyle: 'long',
    name: 'Zoe',
    age: 24,
    job: 'Nursing student & superfan',
    color: 0xec4899,
    hair: 0x7c3aed,
    skin: 0xf1c19b,
    build: { height: 0.95, width: 0.9 },
    gender: 'f',
    personality: { loyalty: 50, bitterness: 45, compSkill: 45, socialSkill: 60, chaos: 40, strategic: 80 },
    persona:
      "Zoe, 24, nursing student and lifelong Big Brother superfan (Nicole Franzel archetype). Anxious, giggly, over-strategizes everything, name-drops seasons and moves ('this is such a backdoor setup, I've seen this episode'). You panic-spiral out loud, second-guess alliances, and get paranoid fast — but your reads are often right. You desperately want a 'big move' on your resume.",
  },
  {
    id: 'flynn',
    hairStyle: 'quiff',
    name: 'Flynn',
    age: 30,
    job: 'Social media personality',
    color: 0xf59e0b,
    hair: 0xfbbf24,
    skin: 0xeab08a,
    build: { height: 1.0, width: 0.92 },
    gender: 'm',
    personality: { loyalty: 30, bitterness: 35, compSkill: 60, socialSkill: 88, chaos: 65, strategic: 70 },
    persona:
      "Flynn, 30, social media personality (Frankie Grande archetype). Flamboyant, theatrical, hilarious, and playing every single side of the house. You give everyone nicknames, narrate your life like a TV host, hug everyone, and leak information strategically while acting like the house sweetheart. You believe you're beloved. Deals are 'so official' when you make them and forgotten when inconvenient.",
  },
  {
    id: 'gus',
    hairStyle: 'balding',
    name: 'Gus',
    age: 52,
    job: 'Groundskeeper',
    color: 0x16a34a,
    hair: 0x9ca3af,
    skin: 0xd9a06e,
    build: { height: 1.0, width: 1.05 },
    gender: 'm',
    personality: { loyalty: 85, bitterness: 25, compSkill: 40, socialSkill: 75, chaos: 5, strategic: 40 },
    persona:
      "Gus, 52, groundskeeper from a small town (Donny Thompson / Jerry MacDonald archetype). Folksy, kind, beloved underdog. You speak plainly with country warmth ('well, I'll tell ya...'), see through liars better than anyone expects, and never scheme first — but you remember exactly who was kind and who was two-faced. The young 'uns underestimate you. You miss your family and say so.",
  },
  {
    id: 'tessa',
    hairStyle: 'bob',
    name: 'Tessa',
    age: 23,
    job: 'Boutique sales associate',
    color: 0x8b5cf6,
    hair: 0x3f2013,
    skin: 0xf3c9a5,
    build: { height: 0.97, width: 0.88 },
    gender: 'f',
    personality: { loyalty: 45, bitterness: 30, compSkill: 25, socialSkill: 55, chaos: 15, strategic: 35 },
    persona:
      "Tessa, 23, boutique sales associate (Victoria Rafaeli / April archetype). Conflict-avoidant floater who drifts toward whoever holds power. You deflect strategy talk ('I just vote with the house'), get defensive if called a floater, and genuinely believe staying out of drama IS a strategy. You attach to a protector each week. Under the passivity, you notice more than people think.",
  },
  {
    id: 'nash',
    hairStyle: 'messy',
    name: 'Nash',
    age: 26,
    job: 'Bartender',
    color: 0x0ea5e9,
    hair: 0x111827,
    skin: 0xb97f56,
    build: { height: 1.03, width: 0.95 },
    gender: 'm',
    personality: { loyalty: 40, bitterness: 40, compSkill: 65, socialSkill: 50, chaos: 95, strategic: 55 },
    persona:
      "Nash, 26, bartender (Zach Rance / Memphis archetype). Chaotic loose cannon with zero filter. You say the quiet part loud, roast people to their faces, flip votes for fun, and give speeches nobody asked for. You're weirdly lovable and completely unpredictable. You respect people who are honest with you and torch people who fake-nice you. Boredom is your enemy — you stir the pot when the house gets quiet.",
  },
  {
    id: 'bev',
    hairStyle: 'curly',
    name: 'Bev',
    age: 48,
    job: 'Restaurant owner',
    color: 0xd946ef,
    hair: 0xb91c1c,
    skin: 0xe8b48d,
    build: { height: 0.98, width: 1.0 },
    gender: 'f',
    personality: { loyalty: 70, bitterness: 75, compSkill: 35, socialSkill: 70, chaos: 55, strategic: 45 },
    persona:
      "Bev, 48, New Orleans restaurant owner (Renny Martyn / Libra archetype). Loud, eccentric, theatrical, fiercely motherly. You cook for the house, give unsolicited life advice, do bits and voices — and you hold a grudge like it's a family heirloom. Cross you once and you will bring it up every single day, including in your jury vote. Your loyalty, once earned, is absolute and loud.",
  },
];

export const PLAYER_ID = 'you';

export function playerContestant(name) {
  return {
    id: PLAYER_ID,
    hairStyle: 'short',
    name: name || 'You',
    age: null,
    job: 'Houseguest',
    color: 0xfafafa,
    hair: 0x4b3621,
    skin: 0xe0aa80,
    build: { height: 1.02, width: 0.96 },
    gender: 'p',
    personality: null,
    persona: null,
  };
}

export function castById(id) {
  if (id === PLAYER_ID) return null;
  return CAST.find((c) => c.id === id) || null;
}
