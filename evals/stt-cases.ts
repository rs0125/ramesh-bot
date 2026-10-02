/** Fictional, locally synthesized regression samples. No customer data or recorded voices. */
export const STT_CASES = [
  {
    id: 'english-visit',
    segments: [
      {
        voice: 'en-in',
        text: 'The warehouse visit is on Monday at three in the afternoon. Meet at gate B. Please bring the floor plan and a measuring tape.',
      },
    ],
    checks: [/monday/i, /three|3/i, /gate\s*b/i, /floor\s*plan/i, /measuring\s*tape/i],
  },
  {
    id: 'english-correction',
    segments: [
      {
        voice: 'en-in',
        text: 'Correction. We need fifteen thousand square feet, not fifty thousand. The fire certificate is not confirmed. Do not book the visit yet.',
      },
    ],
    checks: [
      /15[,. ]?000|fifteen\s*thousand/i,
      /not\s+(?:50[,. ]?000|fifty\s*thousand)/i,
      /fire certificate/i,
      /not confirmed/i,
      /do not book|don.t book/i,
    ],
  },
  {
    id: 'hindi-negation',
    segments: [
      {
        voice: 'hi',
        text: 'कल तीन बजे की विज़िट अभी कन्फर्म नहीं है। मालिक से फायर एन ओ सी की कॉपी मांगना।',
      },
    ],
    checks: [/तीन|3|three/i, /नहीं|nahi|not/i, /मालिक|malik|owner/i, /फायर|fire/i, /कॉपी|copy/i],
  },
  {
    id: 'mixed-language',
    segments: [
      { voice: 'hi', text: 'अगले मंगलवार मीटिंग है।' },
      {
        voice: 'en-in',
        text: 'Please bring the updated floor plan and do not confirm the rent yet.',
      },
      { voice: 'hi', text: 'पहले मालिक से बात कर लेना।' },
    ],
    checks: [
      /मंगलवार|mangalvaar|tuesday/i,
      /floor plan|फ्लोर प्लान/i,
      /do not confirm|don.t confirm|कन्फर्म.{0,12}नहीं/i,
      /rent|रेंट|किराय/i,
      /मालिक|malik|owner/i,
    ],
  },
];
