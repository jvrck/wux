function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current.push(
        Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function choiceToken(choice: string): string {
  return choice.split(" ", 1)[0];
}

export function unknownChoice(kind: string, token: string, choices: readonly string[], helpTarget: string): string {
  const matches = choices.map(choiceToken).filter((choice) => choice !== token && editDistance(token, choice) <= 2);
  const suggestion = matches.length === 1 ? `; did you mean '${matches[0]}'?` : "";
  const listedChoices = choices.length > 0 ? choices.join(", ") : "none";
  return `unknown ${kind}: ${token} (${kind}s: ${listedChoices}; see '${helpTarget} --help')${suggestion}`;
}
