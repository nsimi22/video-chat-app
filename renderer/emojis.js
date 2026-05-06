// Curated emoji set with shortcodes for `:smile:` style replacement and a picker.
// Kept small enough to be inline-loadable; expand freely.
window.EMOJI_GROUPS = [
  {
    name: 'Smileys',
    list: [
      [':smile:', '😄'], [':grin:', '😁'], [':joy:', '😂'], [':rofl:', '🤣'],
      [':sweat_smile:', '😅'], [':wink:', '😉'], [':blush:', '😊'], [':yum:', '😋'],
      [':sunglasses:', '😎'], [':heart_eyes:', '😍'], [':kissing_heart:', '😘'],
      [':thinking:', '🤔'], [':zipper_mouth:', '🤐'], [':neutral_face:', '😐'],
      [':expressionless:', '😑'], [':no_mouth:', '😶'], [':smirk:', '😏'],
      [':unamused:', '😒'], [':eye_roll:', '🙄'], [':grimacing:', '😬'],
      [':lying:', '🤥'], [':relieved:', '😌'], [':pensive:', '😔'], [':sleepy:', '😪'],
      [':drooling:', '🤤'], [':sleeping:', '😴'], [':mask:', '😷'],
      [':dizzy_face:', '😵'], [':exploding_head:', '🤯'], [':cowboy:', '🤠'],
      [':party:', '🥳'], [':disguised:', '🥸'], [':cry:', '😢'], [':sob:', '😭'],
      [':scream:', '😱'], [':angry:', '😠'], [':rage:', '😡'], [':face_palm:', '🤦'],
      [':shrug:', '🤷'],
    ],
  },
  {
    name: 'Reactions',
    list: [
      [':+1:', '👍'], [':-1:', '👎'], [':clap:', '👏'], [':raised_hands:', '🙌'],
      [':pray:', '🙏'], [':muscle:', '💪'], [':ok_hand:', '👌'], [':fist:', '✊'],
      [':wave:', '👋'], [':point_up:', '☝️'], [':point_right:', '👉'],
      [':eyes:', '👀'], [':brain:', '🧠'], [':heart:', '❤️'], [':orange_heart:', '🧡'],
      [':yellow_heart:', '💛'], [':green_heart:', '💚'], [':blue_heart:', '💙'],
      [':purple_heart:', '💜'], [':sparkles:', '✨'], [':fire:', '🔥'],
      [':star:', '⭐'], [':100:', '💯'], [':boom:', '💥'], [':zap:', '⚡'],
      [':rocket:', '🚀'], [':tada:', '🎉'], [':checkered:', '🏁'],
    ],
  },
  {
    name: 'Work',
    list: [
      [':computer:', '💻'], [':keyboard:', '⌨️'], [':desktop:', '🖥️'],
      [':iphone:', '📱'], [':bug:', '🐛'], [':wrench:', '🔧'], [':hammer:', '🔨'],
      [':gear:', '⚙️'], [':lock:', '🔒'], [':key:', '🔑'], [':warning:', '⚠️'],
      [':no_entry:', '⛔'], [':white_check:', '✅'], [':x:', '❌'],
      [':question:', '❓'], [':exclamation:', '❗'], [':bulb:', '💡'],
      [':books:', '📚'], [':memo:', '📝'], [':chart:', '📊'], [':link:', '🔗'],
      [':mag:', '🔍'], [':telephone:', '📞'], [':envelope:', '✉️'],
      [':mailbox:', '📬'], [':alarm:', '⏰'], [':hourglass:', '⏳'],
      [':calendar:', '📅'], [':pushpin:', '📌'], [':paperclip:', '📎'],
      [':coffee:', '☕'], [':taco:', '🌮'], [':pizza:', '🍕'], [':beer:', '🍺'],
    ],
  },
];

window.EMOJI_SHORTCODES = (() => {
  const map = new Map();
  for (const g of window.EMOJI_GROUPS) for (const [code, emoji] of g.list) map.set(code, emoji);
  return map;
})();

window.replaceShortcodes = (text) =>
  text.replace(/:[a-z0-9_+\-]+:/gi, (m) => window.EMOJI_SHORTCODES.get(m.toLowerCase()) || m);

// Most-used reaction set surfaced as quick picks.
window.QUICK_REACTIONS = ['👍', '❤️', '🎉', '😂', '🙏', '🔥', '👀', '✅'];
