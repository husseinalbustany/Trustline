// Small drawn portraits for the roster. Each look is a flat illustration:
// a coloured disc, shoulders, a face and one of eight hairstyles.

type Look = {
  bg: string
  skin: string
  hair: string
  shirt: string
  /** Shapes behind the face, then shapes in front of it. */
  back: string
  front: string
}

const LOOKS: Record<string, Look> = {
  // Long straight hair with a side fringe.
  'girl-1': {
    bg: '#DFF0EF', skin: '#E8B58E', hair: '#3A2418', shirt: '#0F6B6B',
    back: '<path d="M14 30c0-13 8-21 18-21s18 8 18 21v22H14z"/>',
    front: '<path d="M18 26c2-10 9-14 16-13 6 1 11 5 12 12-7-1-13-4-17-9-2 5-6 8-11 10z"/>',
  },
  // Chin-length bob with a straight fringe.
  'girl-2': {
    bg: '#FBE9E7', skin: '#D9A07A', hair: '#1F1A17', shirt: '#B3261E',
    back: '<path d="M15 28c0-12 8-19 17-19s17 7 17 19v12c0 3-2 5-5 5H20c-3 0-5-2-5-5z"/>',
    front: '<path d="M18 25c1-9 7-13 14-13s13 4 14 13c-9-3-19-3-28 0z"/>',
  },
  // Hair gathered in a bun on top.
  'girl-3': {
    bg: '#EFE7FA', skin: '#F0C7A4', hair: '#5A3A22', shirt: '#6B46A8',
    back: '<circle cx="32" cy="9" r="7"/><path d="M17 30c0-11 7-18 15-18s15 7 15 18v6H17z"/>',
    front: '<path d="M18 26c1-9 7-12 14-12s13 3 14 12c-4-4-9-6-14-6s-10 2-14 6z"/>',
  },
  // Long wavy hair, parted in the middle.
  'girl-4': {
    bg: '#FFF1D6', skin: '#C98F66', hair: '#2B1B12', shirt: '#B7791F',
    back: '<path d="M13 31c0-14 9-22 19-22s19 8 19 22c0 6 3 9 1 14s-4 6-3 9H15c1-3-1-4-3-9s1-8 1-14z"/>',
    front: '<path d="M18 27c1-7 5-12 14-13-3 5-8 10-14 13zm28 0c-1-7-5-12-14-13 3 5 8 10 14 13z"/>',
  },
  // Short neat hair.
  'boy-1': {
    bg: '#E3ECF7', skin: '#D9A07A', hair: '#1F1A17', shirt: '#1F5FA8',
    back: '',
    front: '<path d="M18 26c0-10 6-15 14-15s14 5 14 15c-3-5-8-8-14-8s-11 3-14 8z"/>',
  },
  // Curly hair.
  'boy-2': {
    bg: '#DFF0EF', skin: '#C98F66', hair: '#2B1B12', shirt: '#0F6B6B',
    back: '',
    front: '<circle cx="21" cy="19" r="5"/><circle cx="27" cy="14" r="5.5"/><circle cx="34" cy="13" r="5.5"/><circle cx="41" cy="16" r="5"/><circle cx="45" cy="22" r="4"/><circle cx="19" cy="24" r="3.5"/>',
  },
  // Side parting, with glasses.
  'boy-3': {
    bg: '#FFF1D6', skin: '#F0C7A4', hair: '#5A3A22', shirt: '#B7791F',
    back: '',
    front: '<path d="M18 27c-1-11 6-16 15-16 8 0 14 5 13 15-2-5-6-8-10-8-6 3-12 5-18 9z"/><g fill="none" stroke="#12202B" stroke-width="1.6"><circle cx="26.5" cy="29" r="4.2"/><circle cx="37.5" cy="29" r="4.2"/><path d="M30.7 29h2.6"/></g>',
  },
  // Short hair and a trimmed beard.
  'boy-4': {
    bg: '#EFE7FA', skin: '#E8B58E', hair: '#3A2418', shirt: '#6B46A8',
    back: '',
    front: '<path d="M18 25c0-9 6-14 14-14s14 5 14 14c-3-4-8-6-14-6s-11 2-14 6z"/><path d="M19.5 31c1 9 6 14 12.5 14s11.500-5 12.500-14c-2 4-6 6-9 5.500-2-1-5-1-7 0-3 .500-7-1.500-9-5.500z"/>',
  },
}

/** The SVG for one portrait, 64 by 64. Unknown looks get a plain face. */
export function avatarSvg(look: string): string {
  const l = LOOKS[look] ?? LOOKS['boy-1']!
  const hasGlasses = look === 'boy-3'

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    '<defs><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath></defs>',
    '<g clip-path="url(#c)">',
    `<rect width="64" height="64" fill="${l.bg}"/>`,
    `<g fill="${l.hair}">${l.back}</g>`,
    `<path d="M10 64c0-11 9-17 22-17s22 6 22 17z" fill="${l.shirt}"/>`,
    `<rect x="27.500" y="38" width="9" height="10" rx="4" fill="${l.skin}"/>`,
    `<circle cx="32" cy="29" r="13" fill="${l.skin}"/>`,
    `<g fill="${l.hair}">${l.front}</g>`,
    hasGlasses
      ? ''
      : '<circle cx="27" cy="29" r="1.500" fill="#12202B"/><circle cx="37" cy="29" r="1.500" fill="#12202B"/>',
    hasGlasses
      ? '<circle cx="26.500" cy="29" r="1.300" fill="#12202B"/><circle cx="37.500" cy="29" r="1.300" fill="#12202B"/>'
      : '',
    '<path d="M27.500 35c3 2.500 6 2.500 9 0" fill="none" stroke="#12202B" stroke-width="1.500" stroke-linecap="round"/>',
    '</g></svg>',
  ].join('')
}
