/**
 * Whether an event name matches a routing-key pattern, the way a RabbitMQ topic exchange decides:
 * words are joined by dots, `*` stands for exactly one word and `#` for zero or more words.
 */
export function matchesTopic(pattern: string, name: string): boolean {
  const wanted = pattern.split('.');
  const actual = name.split('.');

  const match = (i: number, j: number): boolean => {
    if (i === wanted.length) return j === actual.length;
    if (wanted[i] === '#') {
      for (let skip = j; skip <= actual.length; skip++) {
        if (match(i + 1, skip)) return true;
      }
      return false;
    }
    if (j === actual.length) return false;
    if (wanted[i] === '*' || wanted[i] === actual[j])
      return match(i + 1, j + 1);
    return false;
  };

  return match(0, 0);
}
