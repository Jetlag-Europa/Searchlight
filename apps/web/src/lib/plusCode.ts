/**
 * Splits a Google Plus code input such as "Q9CM+3P Narita, Chiba, Japan" or
 * "9G8F+6X, Zürich" into the code and the locality after it ("" when there is
 * none). A short code needs the locality to be resolved.
 */
export function splitPlusCode(input: string): {
    code: string;
    locality: string;
} {
    const [, code, locality] = input.trim().match(/^([^\s,]*)[\s,]*(.*)$/s)!;
    return { code, locality: locality.replace(/\s+/g, " ") };
}
