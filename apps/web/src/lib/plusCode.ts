/**
 * Splits a Google Plus code input such as "Q9CM+3P Narita, Chiba, Japan" into
 * the code and the locality after it ("" when there is none). A short code
 * needs the locality to be resolved.
 */
export function splitPlusCode(input: string): {
    code: string;
    locality: string;
} {
    const [code = "", ...locality] = input.trim().split(/\s+/);
    return { code, locality: locality.join(" ") };
}
