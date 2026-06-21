import { BUNDLED_SKILLS, type EmbeddedSkill } from "../skills/embedded";
import { WuxError } from "../runtime/errors";

type Writer = { write(chunk: string): unknown };

interface SkillsIO {
  stdout: Writer;
  stderr: Writer;
}

const SKILLS_HELP = `Usage:
  wux skills list [--json]
  wux skills show <name>

Lists or emits bundled Wux companion skills. show writes the selected SKILL.md
bytes verbatim to stdout and has no filesystem side effects.
`;

export async function skillsCommand(args: string[], io: SkillsIO): Promise<void> {
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    io.stdout.write(SKILLS_HELP);
    return;
  }

  switch (command) {
    case "list":
      listSkills(args, io);
      return;
    case "show":
      showSkill(args, io);
      return;
    default:
      if (command.startsWith("-")) throw new WuxError(`unknown option: ${command}`);
      throw new WuxError(`unknown skills command: ${command}`);
  }
}

function listSkills(args: string[], io: SkillsIO): void {
  const json = takeFlag(args, "--json");
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const names = BUNDLED_SKILLS.map((skill) => skill.name);
  io.stdout.write(json ? `${JSON.stringify(names)}\n` : `${names.join("\n")}\n`);
}

function showSkill(args: string[], io: SkillsIO): void {
  const name = args.shift();
  if (!name || name.startsWith("-")) throw new WuxError("skills show requires <name>");
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const skill = findSkill(name);
  if (!skill) throw new WuxError(`skill not found: ${name}`);
  io.stdout.write(skill.content);
}

function findSkill(name: string): EmbeddedSkill | undefined {
  return BUNDLED_SKILLS.find((skill) => skill.name === name);
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function rejectUnknownOptions(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) throw new WuxError(`unknown option: ${unknown}`);
}

function rejectUnexpectedArgs(args: string[]): void {
  if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
}
