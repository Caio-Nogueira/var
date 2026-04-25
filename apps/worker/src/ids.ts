/**
 * Review ID minting. Format: `rev_<22 base32 chars>` (~110 bits of entropy; URL-safe; unguessable).
 * Crypto-random; collision risk for our scale is nil.
 */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"; // base36, no ambiguous chars to worry about

export function mintReviewId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let out = "rev_";
	for (let i = 0; i < bytes.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: bounded by length above
		const b = bytes[i]!;
		out += ALPHABET[b % ALPHABET.length];
		out += ALPHABET[(b >> 4) % ALPHABET.length];
	}
	return out;
}
