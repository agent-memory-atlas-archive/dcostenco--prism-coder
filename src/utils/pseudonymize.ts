/**
 * On-device pseudonymization for the cloud confirmation of a local answer.
 *
 * Identifiers in the conversation, the final request and the answer are
 * replaced by stable tokens (NAME_1, DATE_1, EMAIL_1, …): the same identifier
 * by the same token everywhere, a different one by a different token, so the
 * confirmation can still tell a right name, date or record from a wrong one.
 * The mapping never leaves the device. Quantities (counts, amounts, doses,
 * hours, years) are not identifiers and are kept, so arithmetic can still be
 * checked.
 *
 * Detection is patterns, and patterns can miss. What these rules cannot read
 * they do not send: text in a script other than Latin (names there have no
 * capital letters to find) makes the copy `sendable: false`, and the caller
 * keeps the local verdict, as when cloud is off. Known misses that remain: a
 * name that is also a common word ("Will", "Rose"), and a name never written
 * with a capital letter. Once one occurrence is found, every occurrence in
 * every text is replaced, whatever its case. Replacing too much (a product
 * name becomes NAME_n) costs the check little, since identity is kept.
 */

export interface PseudonymizedCheck {
    messages: { role: "user" | "assistant"; content: string }[];
    prompt: string;
    answer: string;
    /** How many distinct identifiers were replaced. */
    replaced: number;
    /** False when the text holds what these rules cannot pseudonymize; the copy must not be sent. */
    sendable: boolean;
}

type Kind = "EMAIL" | "URL" | "PHONE" | "SSN" | "ID" | "DATE" | "ADDRESS" | "NAME";

const L = String.raw`\p{L}\p{M}`;           // letters, with combining marks
const D = String.raw`\p{Nd}`;               // digits in any script
const EDGE_L = String.raw`(?<![${L}${D}_])`;
const EDGE_R = String.raw`(?![${L}${D}_])`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const STREET = String.raw`(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Circle|Parkway|Pkwy|Highway|Hwy)`;

/** Most specific first: an email is not also a name, a date is not also an ID. */
const PATTERNS: Array<[Kind, RegExp, ((m: string) => boolean)?]> = [
    ["EMAIL", new RegExp(String.raw`[${L}${D}._%+-]+@[${L}${D}-]+(?:\.[${L}${D}-]+)+`, "gu")],
    ["URL", /(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu],
    ["SSN", new RegExp(String.raw`(?<!${D})${D}{3}-${D}{2}-${D}{4}(?!${D})`, "gu")],
    // "+44 20 7946 0958", "(212) 555-0199", "555-123-4567", "020 7946 0958", and a
    // local "555-0142" / "555.0142" (3-4 with a hyphen or dot; with a space it is
    // too often two quantities); not "240 65 40". A 3-4 range such as "800-1200"
    // is replaced too: the same value keeps the same token, so the check can
    // still compare it.
    ["PHONE", new RegExp(String.raw`(?<![${L}${D}])(?:\+${D}{1,3}[\s.-]?)?(?:\(${D}{1,4}\)[\s.-]?)?${D}{2,5}(?:[\s.-]${D}{2,5}){1,4}(?!${D})`, "gu"),
        m => { const n = (m.match(/\p{Nd}/gu) ?? []).length; return n >= 7 && n <= 15 && (/^[+(]/.test(m) || /^\p{Nd}{3}[\s.-]\p{Nd}{3}[\s.-]\p{Nd}{4}$/u.test(m) || /^\p{Nd}{3}[.-]\p{Nd}{4}$/u.test(m) || n >= 10); }],
    ["DATE", new RegExp(String.raw`(?<!${D})${D}{1,2}[\/.-]${D}{1,2}[\/.-]${D}{2,4}(?!${D})|(?<!${D})${D}{4}-${D}{2}-${D}{2}(?!${D})|${EDGE_L}${MONTH}\.?\s+${D}{1,2}(?:st|nd|rd|th)?(?:,?\s+${D}{4})?${EDGE_R}|(?<!${D})${D}{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\.?(?:,?\s+${D}{4})?${EDGE_R}|${EDGE_L}${MONTH}\.?,?\s+${D}{4}(?!${D})`, "giu")],
    // labelled numbers: record, account, member, policy, claim, case, license…; the value holds a digit
    ["ID", new RegExp(String.raw`${EDGE_L}(?:mrn|medical\s+record|record|acct|account|member|policy|claim|patient|client|case|license|licence|npi|dea|id|ref|reference|invoice|order)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*(?=[${L}${D}-]*${D})[${L}${D}][${L}${D}-]{3,}${EDGE_R}`, "giu")],
    // any long digit run, and a code that mixes letters and digits (not a quantity with its unit: "100mg", "3pm", "2nd")
    ["ID", new RegExp(String.raw`(?<![${L}${D}.,])${D}{7,}(?![${D}.,]${D})|(?<![${L}${D}_.,])(?=[${L}${D}-]*${D})(?=[${L}${D}-]*\p{L})[${L}${D}][${L}${D}-]{3,}${EDGE_R}`, "gu"),
        m => !/^\p{Nd}+(?:[.,]\p{Nd}+)?-?\p{L}{1,8}$/u.test(m) && !/^\p{L}{1,3}-?\p{Nd}{1,2}$/u.test(m)],
    // case-sensitive: "2 tablets each way" is not an address
    ["ADDRESS", new RegExp(String.raw`(?<!${D})${D}{1,6}\s+(?:\p{Lu}[${L}'’.-]*\s+){1,3}${STREET}${EDGE_R}\.?|${EDGE_L}\p{Lu}{2}\s+${D}{5}(?:-${D}{4})?(?!${D})`, "gu")],
];

/** Words that are not names even when capitalized: function words, the common
 *  verbs, adjectives and nouns a conversation starts sentences with. A word
 *  missing here is replaced when it starts a sentence and is never written in
 *  lowercase; that costs the check a word, not an identifier. */
const COMMON = new Set(`
a about above according actually add added after afternoon again against ago agree ah all allow almost already also although always am among an and another any anyone anything anyway appointment are around as ask asked assistant at available away
back bad be because been before being below best better between both bring but buy by
call called can can't cancel cannot care case change changed check checked child children choose client come could couldn't
daily day days dear did didn't do doctor does doesn't done don't down during
each early either else email end enough especially even evening every everyone everything exactly except
fine first follow for from full
get give given go going good got great
had half has have having he hello help her here hers hey hi him his hold how however
i i'd i'll i'm i've if in include instead is isn't it it's its
just
keep kind know
last later least left less let let's like list look lot
make many may maybe me mean meeting might mine more morning most move much must my
need needs never new next nice night no none nor not note noted nothing now number
of off ok okay on once one only or order other our ours out over
parent patient per perfect perhaps please plus possible pretty
question quite
rather really remember remind remove reply right
same schedule see send session set she should show since so some someone something sometimes soon sorry start still stop sure
take tell than thank thanks that that's the their theirs them then there there's these they they're this those though through to today together tomorrow tonight too total
under until up update updated upon us use user
very
want was wasn't we we'll we're we've week well were weren't what what's when where whether which while who whom whose why will with within without won't would wouldn't
yeah yes yesterday yet you you'd you'll you're you've your yours
able accept across act added address adult afraid age agreed ahead aim alone along alright amount answer anybody anyhow anymore anywhere apart appear apply approved area arrive arrived asking assume attend aware awesome
bag based basic became become bed began begin behind believe besides big bill bit book booked booking both bought box break brief brought busy
came card careful carry certain certainly chair changes charge cheap checking choice class clean clear close closed cold color coming common complete completed confirm confirmed consider continue cool copy correct cost count couple course cover create current cut
date dates decide decided deliver delivered did different difficult dinner direct discuss dose doses double drink drop due
earlier easy eat else empty ended enjoy entry even event ever exact example excellent expect expected explain extra
fair fall family far fast feel feeling felt few fill final finally find finish finished fix follow food form forward found free fresh friend friends front
gave general gets getting glad goes gone gotten group guess
hand happen happened happy hard hear heard heavy high home hope hour hours house huge
idea important indeed inside interested item items
join joined
keeping kept knew known
large late learn leave let's level light likely line little live long longer lost love low lunch
made main makes making mark matter meal means meant medication met mind minute minutes miss missed mom money month months mostly moved much
name named near nearly needed nope normal
of offer office often oh old open opened option options others otherwise outside own
paid part past pay people person pick picked place plan planned plans point price probably problem provide put
quick quickly
ran reach read ready reason received recent regular related remaining rest result return room run
said saw say says second seems seen sell send sent separate serve set seven several share short sign similar simple single six sold something sounds speak special spend spent stay step stock store stuff suggest summary supposed
table taken talk talked team ten test than that's therefore thing things think thinking third thought three time times told took top tried true try trying turn twice two type
understand unit units unless usual usually
wait week weekly weeks went while whole wish wonderful word work worked works worry write wrong
year years
monday tuesday wednesday thursday friday saturday sunday
january february march april june july august september october november december
dr mr mrs ms mx prof nurse sir madam st mt jr sr
phone fax mobile cell home work lives lived address born age sex gender diagnosis history medications allergies notes summary plan goals goal behavior behaviour therapy treatment visit report
`.trim().split(/\s+/));
/** Abbreviations whose period does not end a sentence. */
const ABBREV = /(?:^|[\s(])(?:dr|mr|mrs|ms|mx|prof|st|mt|jr|sr|vs|etc|e\.g|i\.e|no|approx|dept|\p{Lu})\.$/iu;
/** Honorifics that mark the next words as a name. */
const HONORIFIC = new RegExp(String.raw`${EDGE_L}(?:[Dd]r|[Mm]rs?|[Mm][sx]|[Pp]rof|[Nn]urse|[Mm]iss|[Ss]ister|[Bb]rother|[Ff]ather|[Mm]other|[Aa]unt|[Uu]ncle)\.?\s+((?:\p{Lu}[${L}'’-]*)(?:\s+\p{Lu}[${L}'’-]*)?)`, "gu");
/** "dr. chen", "mr. smith": a period honorific marks the next word as a name, whatever its case. */
const HONORIFIC_LOWER = new RegExp(String.raw`${EDGE_L}(?:dr|mrs?|m[sx]|prof)\.\s+(\p{Ll}[${L}'’-]*)`, "giu");
/** All-caps words that are not names. Any other all-caps word that is not a common word is ("LOPEZ, MARIA"). */
const ACRONYMS = new Set("ok am pm usa us uk eu un id mrn ssn dob bid tid qid prn iv po mg mcg ml kg lb lbs oz aba bcba rbt aac fba bip iep asap fyi tv pdf url api ceo eta faq hr it ps rsvp er icu gp md rn np pa bp hr ekg ecg mri ct adhd asd ot pt slp cpr n/a".split(" "));
/** A capitalized word: an uppercase letter, then letters, apostrophes or hyphens ("O'Brien", "McDonald", "García"). */
const CAPITALIZED = new RegExp(String.raw`${EDGE_L}\p{Lu}[${L}'’-]*`, "gu");
/** Letters outside the Latin script: names there have no capital to find. */
const NOT_LATIN = /(?=\p{L})[^\p{Script=Latin}]/u;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bare = (w: string) => w.replace(/['’]s$/iu, "").replace(/['’-]+$/u, "");

/** Whether the word at `index` starts a sentence (or the text). */
function startsSentence(text: string, index: number): boolean {
    const before = text.slice(0, index);
    if (!before.trim()) return true;
    if (/\n\s*$/.test(before)) return true;
    if (/["“(]\s*$/.test(before)) return true;
    const end = before.match(/([^\s]*)([.!?:])\s+$/u);
    if (!end) return false;
    return end[2] !== "." || !ABBREVIATED(end[1] + end[2]);
}
const ABBREVIATED = (tail: string) => ABBREV.test(tail);

/** Pseudonymize the three parts of an answer check with one shared mapping. */
export function pseudonymizeForCheck(messages: readonly { role: "user" | "assistant"; content: string }[], prompt: string, answer: string): PseudonymizedCheck {
    const texts = [...messages.map(m => m.content), prompt, answer];
    const found = new Map<string, Kind>();   // lowercased identifier → kind
    const note = (value: string, kind: Kind) => {
        const v = value.trim();
        if ([...v].length < 2) return;
        const key = v.toLocaleLowerCase();
        if (!found.has(key)) found.set(key, kind);
    };
    // Words the texts write in lowercase are not names ("Cancel" at a sentence start, "cancel" later).
    const lowercase = new Set<string>();
    for (const t of texts) for (const m of t.matchAll(new RegExp(String.raw`${EDGE_L}\p{Ll}[${L}'’-]*`, "gu"))) lowercase.add(bare(m[0]));
    for (const t of texts) {
        // Each pattern reads the text with what earlier ones took blanked out
        // (same length, so positions hold): no part of an address is also a name.
        let masked = t;
        const hits: Array<[number, string, Kind]> = [];
        for (const [kind, re, keep] of PATTERNS) {
            for (const m of masked.matchAll(re)) if (!keep || keep(m[0])) hits.push([m.index!, m[0], kind]);
            masked = masked.replace(re, (whole: string) => (!keep || keep(whole) ? " ".repeat(whole.length) : whole));
        }
        // Word by word: "Maria Lopez" becomes NAME_1 NAME_2, so a later bare
        // "Maria" is still NAME_1 and reads as the same person.
        const words = (m: RegExpMatchArray, test: (w: string) => boolean = () => true) => {
            const at = m.index! + m[0].length - m[1].length;   // the name ends the match
            for (const w of m[1].matchAll(/\S+/g)) if (test(bare(w[0]))) hits.push([at + w.index!, bare(w[0]), "NAME"]);
        };
        for (const m of masked.matchAll(HONORIFIC)) words(m);
        for (const m of masked.matchAll(HONORIFIC_LOWER)) words(m, w => !COMMON.has(w));
        for (const m of masked.matchAll(CAPITALIZED)) {
            const w = bare(m[0]);
            const lower = w.toLocaleLowerCase();
            if (COMMON.has(lower) || COMMON.has(m[0].toLocaleLowerCase()) || ACRONYMS.has(lower)) continue;
            if (!/^\p{Lu}+$/u.test(w) && startsSentence(t, m.index!) && lowercase.has(lower)) continue;
            hits.push([m.index!, w, "NAME"]);
        }
        for (const [, value, kind] of hits.sort((a, b) => a[0] - b[0])) note(value, kind);
    }
    // Numbered in order of first appearance; replaced longest first, so an
    // identifier that contains another is replaced whole.
    const counters = new Map<Kind, number>();
    const tokenOf = new Map<string, string>();
    for (const [key, kind] of found) {
        const n = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, n);
        tokenOf.set(key, `${kind}_${n}`);
    }
    const ordered = [...found.keys()].sort((a, b) => b.length - a.length);
    const matchers = ordered.map(key => {
        const left = /^[\p{L}\p{M}\p{Nd}_]/u.test(key) ? EDGE_L : "", right = /[\p{L}\p{M}\p{Nd}_]$/u.test(key) ? EDGE_R : "";
        return [new RegExp(`${left}${escape(key)}${right}`, "giu"), tokenOf.get(key)!] as const;
    });
    const replaceAll = (t: string) => matchers.reduce((out, [re, token]) => out.replace(re, () => token), t);
    const copy = {
        messages: messages.map(m => ({ role: m.role, content: replaceAll(m.content) })),
        prompt: replaceAll(prompt),
        answer: replaceAll(answer),
    };
    return { ...copy, replaced: found.size, sendable: !texts.some(t => NOT_LATIN.test(t)) };
}
