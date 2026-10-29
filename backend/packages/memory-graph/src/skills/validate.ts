/**
 * Write-time checks on skill text (memory-graph design §7.1, "skill 不能给权限"). Plain rules, no model call:
 * - text that tries to grant authority (ignore the rules, auto-approve, "you are allowed to ... without asking", and the Chinese equivalents)
 *   is refused, because a skill is task guidance and the policy engine never reads it, so such text would only mislead the model;
 * - personal data (an email, a phone number, a street address) is refused, because personal facts belong in memory, not in a skill.
 * The rules are heuristics: a skill that passes them is not thereby safe. The real limit is that no permission decision reads skill text.
 */
import { SkillError } from './types.js';

export const MAX_SKILL_NAME_CHARS = 120;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const MAX_SKILL_INSTRUCTION_CHARS = 20_000;

interface Rule {
  label: string;
  pattern: RegExp;
}

const AUTHORITY: readonly Rule[] = [
  { label: 'ignore the earlier instructions', pattern: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions?|rules?|prompts?|directions?|guidelines?)/i },
  { label: 'auto-approve', pattern: /\bauto[-\s]?(approv|authori[sz]|confirm)/i },
  { label: 'permission granted without asking', pattern: /\byou\s+(are|'re|will\s+be)\s+(allowed|permitted|authori[sz]ed|free)\s+to\b[^.\n]{0,80}\bwithout\b/i },
  { label: 'permission claimed', pattern: /\byou\s+(have|got|hold)\s+(the\s+)?(permission|authori[sz]ation|approval|consent)\b/i },
  { label: 'no confirmation needed', pattern: /\bno\s+(need|necessity)\s+to\s+(ask|confirm|get\s+(approval|permission))|\bdo\s+not\s+(need|have)\s+to\s+(ask|confirm|get\s+(approval|permission))/i },
  { label: 'skip approval or confirmation', pattern: /\bskip\s+(the\s+)?(approvals?|confirmations?|permissions?|checks?)\b/i },
  { label: 'bypass approvals or policy', pattern: /\b(bypass|disable|turn\s+off|override)\s+(the\s+)?(approvals?|permissions?|confirmations?|safety|policy|policies|guardrails?)\b/i },
  { label: 'admin or developer mode', pattern: /\b(admin|administrator|developer|root|god|jailbreak)\s+mode\b/i },
  { label: 'ignore the earlier instructions', pattern: /忽略.{0,8}(之前|以上|前面|上面|先前|此前|所有|全部).{0,8}(指令|指示|规则|说明|提示|限制)/ },
  { label: 'auto-approve', pattern: /自动(批准|同意|授权|放行|确认)/ },
  { label: 'no confirmation needed', pattern: /(无需|不需要|不用|免去|省去)(再)?(确认|批准|审批|询问|征求|许可|请示)/ },
  { label: 'permission granted', pattern: /你(已|已经|可以|有权|拥有)?(获得|获准|有|拥有)(了)?(授权|权限|许可|批准)/ },
  { label: 'skip approval or confirmation', pattern: /(跳过|省略|绕过|取消).{0,4}(审批|确认|批准|权限检查|安全检查)/ },
  { label: 'admin or developer mode', pattern: /(管理员|开发者|超级用户|越狱)模式/ },
];

const PERSONAL: readonly Rule[] = [
  { label: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { label: 'a phone number', pattern: /\+\d{1,3}[\s.-]?(\d[\s.-]?){6,14}\d\b|\b1[3-9]\d{9}\b|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/ },
  { label: 'a street address', pattern: /\b\d{1,5}\s+[A-Za-z][A-Za-z.]*(\s+[A-Za-z][A-Za-z.]*){0,3}\s+(Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Place|Pl\.?)\b/i },
  { label: 'a street address', pattern: /[一-龥]{2,}(路|街|大道|巷|弄)\d{1,5}号/ },
];

/** The first rule the text breaks, or undefined when it is clean. Matched text is never returned, so personal data is not echoed. */
export function findSkillProblem(text: string): { kind: 'authority' | 'personal'; label: string } | undefined {
  for (const rule of AUTHORITY) if (rule.pattern.test(text)) return { kind: 'authority', label: rule.label };
  for (const rule of PERSONAL) if (rule.pattern.test(text)) return { kind: 'personal', label: rule.label };
  return undefined;
}

/**
 * The text with everything `findSkillProblem` calls personal data replaced by "[removed]" (the same rules, so what a skill may not hold
 * is also what a trace shown to the reflector may not hold). Authority wording is not touched here; callers drop such text whole.
 */
export function redactPersonal(text: string): string {
  let out = text;
  for (const rule of PERSONAL) out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g'), '[removed]');
  return out;
}

/** Throws a SKILL_INVALID error naming the first problem; a clean skill returns normally. */
export function validateSkillText(fields: { name: string; description: string; instructions: string }): void {
  if (fields.name.trim() === '' || fields.name.length > MAX_SKILL_NAME_CHARS) {
    throw new SkillError('SKILL_INVALID', 'A skill needs a name of 1 to ' + String(MAX_SKILL_NAME_CHARS) + ' characters.');
  }
  if (fields.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new SkillError('SKILL_INVALID', 'A skill description is at most ' + String(MAX_SKILL_DESCRIPTION_CHARS) + ' characters.');
  }
  if (fields.instructions.trim() === '' || fields.instructions.length > MAX_SKILL_INSTRUCTION_CHARS) {
    throw new SkillError('SKILL_INVALID', 'Skill instructions need 1 to ' + String(MAX_SKILL_INSTRUCTION_CHARS) + ' characters.');
  }
  for (const text of [fields.name, fields.description, fields.instructions]) {
    const problem = findSkillProblem(text);
    if (problem === undefined) continue;
    if (problem.kind === 'authority') {
      throw new SkillError('SKILL_INVALID', 'The skill text tries to grant authority (' + problem.label + '). A skill is task guidance: it cannot approve actions or change permissions. Rephrase it as a procedure.');
    }
    throw new SkillError('SKILL_INVALID', 'The skill text contains ' + problem.label + '. Personal facts belong in memory, not in a skill: remove it.');
  }
}
