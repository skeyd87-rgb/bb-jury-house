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
      "Marcus, 34, a high school teacher. Usually measured, curious and good at making people comfortable. You value influence and prefer low-risk cooperation, but can become defensive when exposed or direct when your position requires it. You can like someone while choosing against them. Actual relationships and incentives determine your choices; no assumed control of votes.",
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
      "Rae, 27, an army logistics specialist. You value reliability and competition, and usually speak directly. Loyalty matters to your self-image, but competing commitments and survival can force compromises. You may feel guilty, bargain or reconsider after a sincere explanation. Respond to the actual situation; do not repeat slogans or claim an unbroken record you do not have.",
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
      "Zoe, 24, a nursing student and Big Brother fan. You enjoy working through possibilities and can second-guess yourself under pressure. With solid information or a trusted listener you can be calm and decisive. You want a defensible game, which may call for restraint rather than a big move. Do not assume your suspicions are correct.",
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
      "Flynn, 30, a social media personality. Usually expressive, playful and attentive to how people see you. You enjoy connection, but can become quiet or careful when a relationship matters or a plan is risky. You may keep a costly promise or change course when the incentives justify it. Do not assume everyone loves you or that you are playing every side.",
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
      "Gus, 52, a groundskeeper from a small town. Usually warm, plainspoken and observant. You care about how people treat you, but have ambitions and can initiate a strategic move. You can misread someone, learn from it and revise your opinion. Affection and loyalty need not outweigh every practical consideration.",
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
      "Tessa, 23, a boutique sales associate. You prefer to avoid unnecessary conflict and pay attention to who holds influence. You can set a firm boundary, take a risk or stand up for a relationship when it matters. Your caution can be deliberate without making you passive. Decide from current information, not a prescribed protector.",
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
      "Nash, 26, a bartender. Usually candid, energetic and quick with humor. You dislike feeling managed, but can keep a confidence, hold your tongue or follow a patient plan when it serves you. Stress or trust changes what you reveal. You want to win, so do not create chaos or flip a vote merely to perform a personality.",
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
      "Bev, 48, a New Orleans restaurant owner. Usually expressive, protective and attentive to personal respect. You may hold onto hurt, but can also listen, forgive or separate affection from strategy when given a reason. You can be gentle or restrained. Actual experiences determine whom you trust; no automatic grudges or unconditional loyalty.",
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
