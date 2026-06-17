---
name: translate-localize
description: Translate and localize UI strings, app copy, alerts, and docs between languages — primary target Georgian, also Spanish/French/etc. — preserving variables, tags, and file structure. Use whenever asked to translate or localize text or a strings file (.json, .arb, .strings, .yaml, .po), adapt copy for a non-English locale, review or fix an existing translation, or produce Georgian UI/email copy — even if the request just says "translate this" or "make this Georgian." This localizes intent, tone, and register for real interfaces; it is NOT word-for-word translation.
---

# Translate & localize

Localize the *meaning, tone, and register* of UI strings and copy for the target
language — never a word-for-word calque. Output must fit real UI constraints and
must not break code, variables, tags, or file structure.

## Core principles

- **Meaning over mechanics** — translate intent and context, not words. Use native
  idiom and phrasing.
- **UI brevity** — keep strings short enough for buttons, menus, and alerts. Target
  languages usually run longer than English; trim without losing meaning.
- **Structure is sacred** — placeholders, interpolation variables, HTML/XML tags,
  Markdown, and JSON keys are left **exactly** as-is. Translate **values only**.
  - `Hello, {{user_name}}!` → `გამარჯობა, {{user_name}}!`

## Linguistic quality

- **No calques** — avoid literal renderings that sound foreign in the target language.
- **Domain terminology** — use the accepted professional terms for the domain
  (trading, e-commerce, SaaS). Keep recurring terms consistent (see Glossary below).
- **No barbarisms / slang** — avoid unnatural loanwords unless they are genuine
  industry standard (e.g. "click").
- **Formal register by default** — professional, clear, confident; use the polite
  form (Georgian `თქვენ`, French *Vous*) unless context demands informal.

## Georgian specifics (the rules generic translators miss)

- **Formality is carried by the verb, not just the pronoun.** Use 2nd-person-plural
  verb forms (`გსურთ`, `ხართ`, `მოგესალმებით`); the pronoun `თქვენ` is usually dropped.
  Informal `შენ`/singular verbs read as too familiar for an interface.
- **No capitalization.** Mkhedruli is unicameral — Georgian has **no capital letters.**
  Do not Title-Case, do not capitalize mid-sentence. If a design needs all-caps
  styling, that is Mtavruli applied via CSS/font (`text-transform`), never by
  transforming letters inside the string.
- **The variable-inflection trap.** Georgian inflects nouns across **7 cases**, but a
  fixed `{{var}}` can't bend. Don't try to append case endings to a variable — keep it
  in the **nominative** and restructure the sentence so no oblique case is required.
  - Source: `{{coin}} price rose 5%`
  - ❌ Trap (needs a genitive you can't reliably build): `{{coin}}-ის ფასი 5%-ით გაიზარდა`
  - ✅ Safe (variable stays nominative): `{{coin}} — ფასი 5%-ით გაიზარდა`
- **Numerals take the singular** — `5 ფაილი`, never `5 ფაილები`.
- **Localize formats** — dates `DD.MM.YYYY`, currency `₾` / GEL, and number separators.
  Literary convention prefers `„…“` or `«…»` quotation marks (optional for UI).

## Glossary (keep a term map per project)

Maintain a small source→target glossary for recurring domain terms so they render
identically everywhere (email + dashboard + alerts). Decide each *once*:

| English | Georgian | note |
|---|---|---|
| support | მხარდაჭერა | |
| resistance | წინააღმდეგობა | |
| zone / level | ზონა / დონე | pick one to match the app's own wording |

## Execution

When translating a **file** (`.json`, `.arb`, `.strings`, `.yaml`, `.po`):

1. Preserve the structure byte-for-byte — keys, tags, variables, and indentation
   untouched; translate only the human-readable values.
2. Produce valid **UTF-8**, no BOM. No conversational filler wrapping a file deliverable.
3. In a repo, edit the file in place rather than pasting a block. **Do not commit or
   push** — summarise what changed and let the owner commit. (In Criptis the handoff
   rule and the "advisory trader-assistant, beginner-friendly, with a risk note" copy
   stance live in `CLAUDE.md`; this skill inherits them — keep the register compatible.)

If a term is ambiguous, choose the most common term used in modern Georgian digital
interfaces, and add it to the project glossary.

## Examples

| Source (trading app) | ❌ Literal | ✅ Localized |
|---|---|---|
| Support / Resistance zones | ქვედა / ზედა ზონები *(lower/upper — meaning lost)* | მხარდაჭერის / წინააღმდეგობის დონეები |
| Are you sure you want to delete this file? This action cannot be undone. | …არ შეიძლება დაბრუნდეს *(robotic)* | ნამდვილად გსურთ ფაილის წაშლა? ამ მოქმედების გაუქმება შეუძლებელია. |

> Adding more target languages? Move each language's rules into `references/<lang>.md`
> and keep this SKILL.md as the shared workflow — Claude reads only the relevant one.
