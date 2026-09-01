export const QUESTION_QUANTITY_SLOT = '\u{e000}';
export const QUESTION_CHOICE_SLOT = '\u{e001}';
export const QUESTION_OPTIONAL_QUANTITY_SLOT = '\u{e002}';
export const QUESTION_VALUE_SLOT_SPLIT_PATTERN = /([\u{e000}\u{e001}\u{e002}])/u;
const QUESTION_LITERAL_BOUNDARY = '\u{e003}';
const QUESTION_UNSAFE_SEPARATOR = '\u{e004}';
const QUESTION_WRAPPER_OPEN = '\u{e005}';
const QUESTION_WRAPPER_CLOSE = '\u{e006}';
const QUESTION_RESERVED_MARKER_PATTERN = /[\u{e000}-\u{e006}]/u;
const QUESTION_SKELETON_ATOM_PATTERN =
  /\p{Script=Han}+|[\p{Script=Latin}\p{N}]+(?:[-._:/+][\p{Script=Latin}\p{N}]+)*/gu;
const QUESTION_IGNORABLE_GAP_PATTERN = /^[\s\u{e005}\u{e006}]*$/u;
const QUESTION_QUANTITY_NUMBER_PATTERN = /^(?:\p{N}+|[零〇一二两三四五六七八九十百千万亿]+)$/u;
const QUESTION_QUANTITY_VALUE_PATTERN =
  /^(?:\p{N}+|[零〇一二两三四五六七八九十百千万亿]+)(?:[\p{Script=Latin}][\p{Script=Latin}\p{N}]*|个|份|次|种|项|名|位|家|条|台|套|本|张|件|笔|元|天|年|月|人)?$/u;
const QUESTION_QUANTITY_UNIT_PREFIX_PATTERN =
  /^(?:平方公里|平方厘米|立方厘米|人民币|平方米|立方米|公斤|千克|小时|分钟|公里|千米|厘米|毫米|美元|欧元|英镑|日元|毫升|个|份|次|种|项|名|位|家|条|台|套|本|张|件|笔|元|天|年|月|人|克|吨|秒|米|升)/u;
const QUESTION_MONEY_VALUE_PATTERN =
  /^(?:\p{N}+(?:\.\p{N}+)?|[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]+)(?:元|角|分)$/u;
const QUESTION_SPACED_LITERAL_QUANTITY_PATTERN = new RegExp(
  `^\\p{N}+${QUESTION_LITERAL_BOUNDARY}[\\p{Script=Latin}][\\p{Script=Latin}\\p{N}]*$`,
  'u',
);
const QUESTION_BETA_PAYMENT_OBJECTS = new Set([
  '费用',
  '学费',
  '水费',
  '服务费',
  '平台服务费',
  '说明书费用',
  '申请材料费',
]);
const QUESTION_BETA_CHOICE_HAN_VALUES = new Set(['前三次', '管理员', '验证码', '支付宝']);
const QUESTION_BETA_CHOICE_LITERAL_VALUES = new Set([
  'oauth',
  '2fa',
  'oauth2.0',
  'oauth-2',
  'oauth_2.0',
]);
const QUESTION_BETA_LITERAL_SUBJECTS = new Set(['api', 'sdk', 'cli']);
const QUESTION_BETA_SUBJECT_PATTERN =
  /(?:我|我们|用户|客户|消费者|管理员|账户|系统|平台|服务|应用|客户端|订单)$/u;
const ACTION_OUTCOME_CONTINUATION_PHRASES = Object.freeze([
  '然后',
  '即可',
  '并且',
  '而且',
  '但是',
  '并',
  '且',
  '但',
  '后',
]);
const ACTION_OUTCOME_CONTINUATION_PREFIXES = Object.freeze([
  '后即可',
  ...ACTION_OUTCOME_CONTINUATION_PHRASES,
]);
const QUESTION_FORMATTING_WRAPPER_PAIRS = new Map<string, string>([
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['【', '】'],
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['‘', '’'],
]);
const QUESTION_FORMATTING_WRAPPER_CLOSES = new Set(QUESTION_FORMATTING_WRAPPER_PAIRS.values());
const QUESTION_SYMMETRIC_WRAPPERS = new Set(['"', "'"]);
const QUESTION_FORMATTING_WRAPPER_CHARACTER_PATTERN = /["'“”‘’()[\]（）《》「」『』【】]/gu;

function isSupportedFormattingValue(value: string): boolean {
  const compact = value
    .replaceAll(QUESTION_FORMATTING_WRAPPER_CHARACTER_PATTERN, '')
    .replaceAll(/\s/gu, '');
  if (compact === '') return false;
  const normalized = compact.toLocaleLowerCase('und');
  return (
    QUESTION_BETA_CHOICE_LITERAL_VALUES.has(normalized) ||
    QUESTION_BETA_CHOICE_HAN_VALUES.has(compact) ||
    QUESTION_QUANTITY_NUMBER_PATTERN.test(compact) ||
    QUESTION_QUANTITY_VALUE_PATTERN.test(compact) ||
    QUESTION_MONEY_VALUE_PATTERN.test(compact) ||
    isDirectBetaPaymentValueSegment(compact)
  );
}

function encodedFormattingWrappers(value: string): string | null {
  const stack: { close: string; contentStart: number }[] = [];
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charAt(index);
    if (QUESTION_SYMMETRIC_WRAPPERS.has(point)) {
      const top = stack.at(-1);
      if (top !== undefined && top.close === point) {
        if (!isSupportedFormattingValue(value.slice(top.contentStart, index))) {
          return null;
        }
        stack.pop();
        encoded += QUESTION_WRAPPER_CLOSE;
      } else {
        stack.push({ close: point, contentStart: index + 1 });
        encoded += QUESTION_WRAPPER_OPEN;
      }
      continue;
    }
    const close = QUESTION_FORMATTING_WRAPPER_PAIRS.get(point);
    if (close !== undefined) {
      stack.push({ close, contentStart: index + 1 });
      encoded += QUESTION_WRAPPER_OPEN;
      continue;
    }
    if (QUESTION_FORMATTING_WRAPPER_CLOSES.has(point)) {
      const top = stack.at(-1);
      if (top === undefined || top.close !== point) return null;
      if (!isSupportedFormattingValue(value.slice(top.contentStart, index))) return null;
      stack.pop();
      encoded += QUESTION_WRAPPER_CLOSE;
      continue;
    }
    encoded += point;
  }
  return stack.length === 0 ? encoded : null;
}

export function hasReservedQuestionPatternMarker(value: string): boolean {
  return QUESTION_RESERVED_MARKER_PATTERN.test(value);
}

function completeWrappedValue(value: string): string | null {
  let unwrapped = value;
  while (
    unwrapped.startsWith(QUESTION_WRAPPER_OPEN) &&
    unwrapped.endsWith(QUESTION_WRAPPER_CLOSE)
  ) {
    unwrapped = unwrapped.slice(QUESTION_WRAPPER_OPEN.length, -QUESTION_WRAPPER_CLOSE.length);
  }
  return unwrapped.includes(QUESTION_WRAPPER_OPEN) || unwrapped.includes(QUESTION_WRAPPER_CLOSE)
    ? null
    : unwrapped;
}

export function betaPaymentObject(value: string): string | null {
  return QUESTION_BETA_PAYMENT_OBJECTS.has(value) ? value : null;
}

export function isBetaQuestionSubject(value: string): boolean {
  if (QUESTION_BETA_SUBJECT_PATTERN.test(value)) return true;
  return [...value.matchAll(QUESTION_SKELETON_ATOM_PATTERN)].some((match) =>
    QUESTION_BETA_LITERAL_SUBJECTS.has(match[0].toLocaleLowerCase('und')),
  );
}

export function isDirectBetaPaymentValueSegment(value: string): boolean {
  if (value.includes(QUESTION_LITERAL_BOUNDARY) || value.includes(QUESTION_UNSAFE_SEPARATOR)) {
    return false;
  }
  const whole = completeWrappedValue(value);
  const candidates = whole !== null && whole !== value ? [whole, value] : [value];
  for (const segment of candidates) {
    if (QUESTION_MONEY_VALUE_PATTERN.test(segment)) return true;
    for (const object of QUESTION_BETA_PAYMENT_OBJECTS) {
      if (segment === object) return true;
      if (!segment.endsWith(object)) continue;
      let amount = segment.slice(0, -object.length);
      if (amount.endsWith('的')) amount = amount.slice(0, -1);
      const unwrappedAmount = completeWrappedValue(amount);
      if (unwrappedAmount !== null && QUESTION_MONEY_VALUE_PATTERN.test(unwrappedAmount)) {
        return true;
      }
    }
  }
  return false;
}

export function hasMalformedBetaPaymentValueSegment(value: string): boolean {
  if (isDirectBetaPaymentValueSegment(value)) return false;
  return (
    /(?:元|角|分)$/u.test(value) ||
    [...QUESTION_BETA_PAYMENT_OBJECTS].some((object) => value.endsWith(object))
  );
}

export function validBetaQuestionSlotFill(
  slot: string,
  fill: string,
  fixedSuffix: string | null,
): boolean {
  if (slot === QUESTION_OPTIONAL_QUANTITY_SLOT && fill === '') return true;
  if (fill === '') return false;
  if (slot === QUESTION_CHOICE_SLOT) {
    const choice = completeWrappedValue(fill);
    if (choice === null) return false;
    const normalized = choice.toLocaleLowerCase('und');
    return (
      QUESTION_BETA_CHOICE_LITERAL_VALUES.has(normalized) ||
      QUESTION_BETA_CHOICE_HAN_VALUES.has(choice)
    );
  }
  const hasPaymentObjectSuffix = fixedSuffix !== null && betaPaymentObject(fixedSuffix) !== null;
  if (hasPaymentObjectSuffix) {
    const money = completeWrappedValue(fill.endsWith('的') ? fill.slice(0, -1) : fill);
    return money !== null && QUESTION_MONEY_VALUE_PATTERN.test(money);
  }
  const value = completeWrappedValue(fill);
  if (value === null) return false;
  if (fixedSuffix !== null && QUESTION_QUANTITY_UNIT_PREFIX_PATTERN.test(fixedSuffix)) {
    return QUESTION_QUANTITY_NUMBER_PATTERN.test(value);
  }
  return (
    QUESTION_MONEY_VALUE_PATTERN.test(value) ||
    QUESTION_QUANTITY_VALUE_PATTERN.test(value) ||
    QUESTION_SPACED_LITERAL_QUANTITY_PATTERN.test(value)
  );
}

export function supportedActionOutcome(
  value: string,
  hasOutcomePredicate: (value: string) => boolean,
): boolean {
  if (value === '') return true;
  return ACTION_OUTCOME_CONTINUATION_PREFIXES.some(
    (prefix) => value.startsWith(prefix) && hasOutcomePredicate(value.slice(prefix.length)),
  );
}

export function directActionSegment(
  value: string,
  hasOutcomePredicate: (value: string) => boolean,
): string {
  let boundary = value.length;
  for (const phrase of ACTION_OUTCOME_CONTINUATION_PREFIXES) {
    let fromIndex = 0;
    while (fromIndex <= value.length - phrase.length) {
      const index = value.indexOf(phrase, fromIndex);
      if (index < 0) break;
      if (supportedActionOutcome(value.slice(index), hasOutcomePredicate)) {
        boundary = Math.min(boundary, index);
      }
      fromIndex = index + phrase.length;
    }
  }
  return value.slice(0, boundary).trimEnd();
}

export function connectedSkeletonText(value: string): string {
  if (hasReservedQuestionPatternMarker(value)) return QUESTION_UNSAFE_SEPARATOR;
  const text = encodedFormattingWrappers(value.normalize('NFC').toLocaleLowerCase('und'));
  if (text === null) return QUESTION_UNSAFE_SEPARATOR;
  const matches = [...text.matchAll(QUESTION_SKELETON_ATOM_PATTERN)];
  if (matches.length === 0) return '';
  let skeleton = '';
  let cursor = 0;
  let priorLiteral = false;
  for (const match of matches) {
    const literal = !/^\p{Script=Han}+$/u.test(match[0]);
    const gap = text.slice(cursor, match.index);
    if (gap !== '') {
      if (!QUESTION_IGNORABLE_GAP_PATTERN.test(gap)) {
        skeleton += QUESTION_UNSAFE_SEPARATOR;
      } else if (gap.includes(QUESTION_WRAPPER_OPEN) || gap.includes(QUESTION_WRAPPER_CLOSE)) {
        skeleton += gap.replaceAll(/\s/gu, '');
      } else if (literal && priorLiteral) {
        skeleton += QUESTION_LITERAL_BOUNDARY;
      }
    }
    skeleton += match[0];
    cursor = match.index + match[0].length;
    priorLiteral = literal;
  }
  const trailing = text.slice(cursor);
  if (trailing !== '') {
    if (!QUESTION_IGNORABLE_GAP_PATTERN.test(trailing)) {
      skeleton += QUESTION_UNSAFE_SEPARATOR;
    } else if (
      trailing.includes(QUESTION_WRAPPER_OPEN) ||
      trailing.includes(QUESTION_WRAPPER_CLOSE)
    ) {
      skeleton += trailing.replaceAll(/\s/gu, '');
    }
  }
  return skeleton;
}

export function hasUnsafeConnectedSkeletonSeparator(value: string): boolean {
  return value.includes(QUESTION_UNSAFE_SEPARATOR);
}

export function connectedSkeletonPatternText(value: string): string {
  return value
    .split(QUESTION_VALUE_SLOT_SPLIT_PATTERN)
    .map((part) =>
      part === QUESTION_QUANTITY_SLOT ||
      part === QUESTION_CHOICE_SLOT ||
      part === QUESTION_OPTIONAL_QUANTITY_SLOT
        ? part
        : connectedSkeletonText(part),
    )
    .join('');
}

export function matchesConnectedSkeleton(
  pattern: string,
  target: string,
  validSlotFill: (slot: string, fill: string, fixedSuffix: string | null) => boolean,
): boolean {
  if (hasUnsafeConnectedSkeletonSeparator(pattern) || hasUnsafeConnectedSkeletonSeparator(target)) {
    return false;
  }
  if (!QUESTION_VALUE_SLOT_SPLIT_PATTERN.test(pattern)) return target.includes(pattern);
  const parts = pattern.split(QUESTION_VALUE_SLOT_SPLIT_PATTERN).filter((part) => part !== '');
  let cursor = 0;
  let pendingSlot: string | null = null;
  let finalFixedSuffix: string | null = null;
  for (const part of parts) {
    if (
      part === QUESTION_QUANTITY_SLOT ||
      part === QUESTION_CHOICE_SLOT ||
      part === QUESTION_OPTIONAL_QUANTITY_SLOT
    ) {
      if (pendingSlot !== null) return false;
      pendingSlot = part;
      continue;
    }
    const found = target.indexOf(part, cursor);
    if (found < 0) return false;
    if (pendingSlot !== null) {
      if (!validSlotFill(pendingSlot, target.slice(cursor, found), part)) return false;
      pendingSlot = null;
      finalFixedSuffix = part;
    }
    cursor = found + part.length;
  }
  if (pendingSlot !== null) return validSlotFill(pendingSlot, target.slice(cursor), null);
  return finalFixedSuffix === null || target.indexOf(finalFixedSuffix, cursor) < 0;
}
