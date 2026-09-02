/* The look of answer option N. Shared by the builder, host screen and player pad
   so option 3 is the same amber circle everywhere. Supports up to 8 options. */

const ANSWER_STYLES = [
  { glyph: '▲', color: '#e8434f', name: 'triangle' },
  { glyph: '◆', color: '#2a7fe0', name: 'diamond' },
  { glyph: '●', color: '#f0a51e', name: 'circle' },
  { glyph: '■', color: '#1fa864', name: 'square' },
  { glyph: '★', color: '#8b5cf6', name: 'star' },
  { glyph: '⬢', color: '#14b8a6', name: 'hexagon' },
  { glyph: '♥', color: '#ec4899', name: 'heart' },
  { glyph: '✚', color: '#f97316', name: 'cross' },
];

const answerStyle = (index) => ANSWER_STYLES[index % ANSWER_STYLES.length];
