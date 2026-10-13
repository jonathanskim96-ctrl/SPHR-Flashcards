// Text-answer normalizer. The expression after `=>` must stay byte-for-byte identical to
// `norm` in scripts/validate-bank.mjs (scripts/norm-parity.test.mjs checks this and fuzzes
// both). Decided rule: lowercase, collapse whitespace, trim, drop one trailing period.
// This file must not import anything (the Node parity test loads it directly).
// prettier-ignore
export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');
