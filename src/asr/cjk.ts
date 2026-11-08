/** One CJK character or full-width punctuation mark. */
export const CJK = /[⺀-鿿豈-﫿＀-￯]/

const SPACE_BETWEEN_CJK = new RegExp(`(?<=${CJK.source})\\s+(?=${CJK.source})`, "g")

/** Removes the spaces a recognizer puts between Chinese characters and after full-width punctuation; spaces next to other scripts stay. */
export const closeCjkSpaces = (text: string): string => text.replace(SPACE_BETWEEN_CJK, "")
