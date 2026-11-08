// Joining the words of a transcript back into text, for services that return words rather than sentences.

import { CJK } from "../cjk.ts"

/** Words are separated by spaces except between CJK characters, which Deepgram returns one by one. */
export function joinWords(words: string[]): string {
  return words.reduce((text, word) => (text && !(CJK.test(text.slice(-1)) && CJK.test(word[0])) ? `${text} ${word}` : text + word), "")
}
