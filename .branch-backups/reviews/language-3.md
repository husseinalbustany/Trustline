## Decisions (taken by the lead; apply all of this)

All rows of the three tables are accepted, optional ones included, and both new keys.
Both layout faults that matter are accepted with the fixes proposed (the code as one
left-to-right hyphenated string; the date-field alignment rule), and the four small ones.

On the seven points that needed a decision:
1. Accepted: add `publicReport.urgent` as worded, on the public form and with the "too many" message.
2. Reword so the promise stays true. The name is seen only by staff the hospital has
   authorised to see who reported, normally the quality team. Write it that way in
   `whoSeesName`, `reporterHidden` and anywhere else that says "only the quality team",
   in the three languages, keeping the reviewer's structure for those rows.
3. Accepted: add the sentence after `publicReport.privacy` and `anonymousWarning`.
4. Accepted: the code card shows the follow-up address (left-to-right, with a copy button)
   and `incidents.code.later` changes as proposed.
5. Accepted: a clock time instead of a relative one in both "too many" messages.
6. Accepted: the plain-word `publicReport.description` and `publicReport.poster`.
7. Accepted: the public form gets its own plainer labels and its own errors that never
   say "reload the page"; write them in the same vocabulary and list them in your report.

---

## Language review 3: public reporting, follow-up code, reporter privacy, sign-off, settings (en / ar / fr)

No repository file changed and no server started. Parity, placeholders and French spacing are clean, and review 2 was applied as written with one gap (date fields). The new problems are these: the follow-up code is laid out so an Arabic reader can copy it in the wrong order, several public strings leave the reader without a next step or read as something frightening, and names inserted into Arabic and French sentences break gender agreement again.

French proposals below show ordinary spaces; run them through `frs()` as before.

---

## Arabic (20 changes, 3 more that depend on a decision)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `followUp.close` | إنهاء وإخفاء البلاغ | الخروج وإخفاء البلاغ | Both nouns govern «البلاغ», so it reads "terminate and hide the report". A reporter may fear the button cancels the report |
| 2 | `incidents.detail.reporterHidden` | يطّلع عليه فريق الجودة فقط | لا يطّلع على هذه الخانة سوى فريق الجودة | Under the label «المبلّغ», «عليه» points at a person, so it implies a name exists. "This field" is neutral: it could hold a name or «دون ذكر الاسم» |
| 3 | `incidents.form.whoSeesName` | يُحفظ اسمك مع هذا البلاغ، ولا يطّلع عليه سوى فريق الجودة. أما بقية… | إن لم تحدّد هذا الخيار، يُحفظ اسمك مع البلاغ ولا يطّلع عليه سوى فريق الجودة. أما بقية من يعملون على البلاغ فيظهر لهم «المبلّغ» بدلًا من اسمك. | The sentence sits directly under the tick-box label «الإبلاغ دون ذكر الاسم» (`ar-390-report-form-named.png`), where a description of that option is expected. Skimmed, it says "Report anonymously: your name is saved" |
| 4 | `publicReport.unavailable` | هذا الرابط غير مستخدم. للإبلاغ عن حادث، اسأل فريق الجودة في المستشفى عن الطريقة. | هذا الرابط غير مستخدم. للإبلاغ عن حادث، تحدّث إلى أحد موظفي المستشفى أو إلى فريق الجودة. | A visitor cannot find "the quality team"; «عن الطريقة» is a calque of "ask how" |
| 5 | `incidents.detail.awaiting` | طلب {name} إغلاق هذا الحادث بتاريخ {date}. يُغلق الحادث… | طلب إغلاق هذا الحادث مقدَّم من {name} بتاريخ {date}. يُغلق الحادث عندما يعتمد شخص ثانٍ إغلاقه. | Seen as «طلب نورة الجودة إغلاق…» (`ar-390-timeline-sign-off.png`, `ar-390-awaiting-second-person.png`): masculine verb with a woman's name. The noun form needs no agreement |
| 6 | `admin.organization.reporting.help` | …دون تسجيل الدخول، ويكون {name} محدَّدًا مسبقًا مكانًا للوقوع. | …دون تسجيل الدخول، مع تحديد {name} مسبقًا مكانًا للوقوع. | Seen as «ويكون وحدة العناية المركزة محدَّدًا» (`ar-390-unit-reporting.png`): wrong gender for every feminine unit name |
| 7 | `incidents.status.awaiting_sign_off` | بانتظار الاعتماد | بانتظار اعتماد الإغلاق | Bare «الاعتماد» already means accreditation in `ar.json` («معيار الاعتماد», lines 456 and 494) and in every quality department. With «الإغلاق» it cannot be misread |
| 8 | `incidents.timeline.events.withdrawn` | سحب طلب الاعتماد | سحب طلب اعتماد الإغلاق | Same |
| 9 | `incidents.errors.same_person` | …شخص آخر لديه صلاحية الاعتماد. | …شخص آخر لديه صلاحية اعتماد الإغلاق. | Same |
| 10 | `incidents.errors.missing_sign_off` | …ممن لديه صلاحية الاعتماد، أو… | …ممن لديه صلاحية اعتماد الإغلاق، أو تواصل مع مسؤول النظام. | Same |
| 11 | `incidents.actions.kinds.send_back` | إعادة لاستكمال المعالجة | إعادة الحادث لاستكمال المعالجة | The only button without an object; every other one is a full construct («إغلاق الحادث», «سحب الطلب») |
| 12 | `incidents.timeline.events.sent_back` | الإعادة لاستكمال المعالجة | إعادة الحادث لاستكمال المعالجة | Same words for the action and its timeline entry, as for the other three |
| 13 | `publicReport.privacy` | …بعد الإرسال يظهر لك رمز تعود به لقراءة رد المستشفى. | …بعد الإرسال يظهر لك رمز متابعة تعود به لقراءة أي رد من المستشفى. | «رمز» alone follows a QR «رمز» the reader has just scanned. «رد المستشفى» promises a reply that may not come |
| 14 | `publicReport.tooMany` | أُرسل عدد كبير من البلاغات خلال الساعة الماضية، ولذلك لم يُرسَل هذا البلاغ. ما كتبته ما زال هنا. ستتمكن من المحاولة مرة أخرى {when}. | بلغ عدد البلاغات المرسلة خلال الساعة الماضية الحد المسموح به، ولذلك لم يُرسَل هذا البلاغ. أبقِ هذه الصفحة مفتوحة: ما كتبته ما زال هنا. يمكنك المحاولة مرة أخرى {when}. | "A large number were sent" does not say a limit was reached. The text survives only while the page stays open. See decision 5 for «خلال 12 دقيقة» |
| 15 | `followUp.lost` | الرمز المفقود لا يمكن استرجاعه ولا استبداله. | الرمز المفقود لا يمكن استرجاعه ولا استبداله. لكنّ بلاغك وصل إلى المستشفى. | Someone who lost the code needs to know the report itself is not lost |
| 16 | `incidents.code.keepSafe` | …يستطيع قراءة الردود على البلاغ وكتابة تعليقات… | كل من يحصل على هذا الرمز يستطيع قراءة البلاغ والردود عليه وكتابة تعليقات بصفة المبلّغ. احتفظ به لنفسك. | The holder also reads the report itself |
| 17 | `followUp.wrong` | هذا الرمز لا يفتح أي بلاغ. قارنه بما دوّنته ثم حاول مرة أخرى. | هذا الرمز لا يفتح أي بلاغ. قارنه بما دوّنته ثم حاول مرة أخرى. لا يحتوي الرمز أبدًا على 0 أو 1 أو I أو L أو O. | The alphabet has no look-alikes (`follow-up-code.ts:14`); saying so resolves most copying mistakes |
| 18 | `incidents.actions.note.send_back` | ما الذي ينقص قبل إغلاق هذا الحادث | ما ينقص قبل إغلاق هذا الحادث | A field label, not a question; the others are noun phrases |
| 19 | `incidents.actions.help.send_back` | يعود الحادث إلى المعالجة. اذكر ما الذي ينقص. | يعود الحادث إلى المعالجة. اذكر ما ينقص. | Follows row 18 |
| 20 | `admin.permissions.incidents.see_reporter` | معرفة مَن أبلغ عن الحادث | الاطلاع على اسم المبلّغ | Optional. Parallel with «الاطلاع على الحوادث» and uses the product's noun |

**Depend on a decision** (wording in the decisions section): `publicReport.description`, `publicReport.poster`, `incidents.code.later`.

**Good as written:** `anonymousWarning`, all of `incidents.code` except rows above, `followUp.intro`, `codeHelp`, `notKept`, `viewHelp`, `closeHelp`, `publicReport.haveCode` / `followUp` / `sentHelp`, the four `actions.help` texts, `sign_off_required`, `kind_required`, `revision_required`, `noteHelpInternal`, `list.serious` / `seriousHelp` / `reportedJustNow`, `dashboard.clock`, and all of `admin.settings` («نشط» / «غير نشط» with «تفعيل» / «إلغاء التفعيل» follows option A).

## French (17 changes, 3 more that depend on a decision)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `publicReport.poster` | …Aucune connexion n'est nécessaire. | …Vous n'avez pas besoin de compte. | On a printed poster «aucune connexion» reads "no internet connection needed", which is false. «Connexion» means the network two lines away in `publicReport.loadError` |
| 2 | `admin.settings.reporting.title` | Déclaration sans connexion | Déclaration sans authentification | «Sans connexion» is the usual French for "offline" |
| 3 | `admin.settings.reporting.followUpHelp` | …que la déclaration sans connexion soit activée ou non… | …que la déclaration sans authentification soit activée ou non… | Follows row 2 |
| 4 | `admin.organization.reporting.help` | …accède au formulaire de déclaration, sans connexion, avec {name} déjà sélectionné comme lieu. | Toute personne qui ouvre ce lien ou scanne ce code accède au formulaire de déclaration sans se connecter. Le lieu est déjà renseigné : {name}. | Seen as «avec Unité de soins intensifs déjà sélectionné» (`fr-390-unit-reporting.png`): wrong agreement for every feminine name. Also row 2 |
| 5 | `publicReport.loadError` | Vérifiez votre connexion, puis rechargez la page. | Vérifiez votre connexion Internet, puis rechargez la page. | Separates the network sense from sign-in on the public pages |
| 6 | `followUp.error` | Une erreur s'est produite. Vérifiez votre connexion, puis réessayez. | Une erreur s'est produite. Vérifiez votre connexion Internet, puis réessayez. | Same |
| 7 | `followUp.close` | Terminer et masquer la déclaration | Quitter et masquer la déclaration | «Terminer la déclaration» reads "finish the declaration" |
| 8 | `incidents.detail.reporterHidden` | Visible uniquement par l'équipe qualité | Seule l'équipe qualité voit cette information | Under «Déclaré par», "visible" implies a name is there (`fr-390-detail-reporter-hidden.png`) |
| 9 | `incidents.form.whoSeesName` | Votre nom est enregistré avec cette déclaration. Seule… | Si vous ne cochez pas cette case, votre nom est enregistré avec la déclaration. Seule l'équipe qualité peut le voir : les autres personnes qui traitent la déclaration voient « Le déclarant » à la place. | As Arabic row 3 |
| 10 | `publicReport.unavailable` | …demandez à l'équipe qualité de l'hôpital comment procéder. | Ce lien n'est pas en service. Pour déclarer un incident, adressez-vous à un membre du personnel ou à l'équipe qualité de l'hôpital. | A visitor cannot find the quality team |
| 11 | `incidents.detail.awaiting` | {name} a demandé la clôture de cet incident le {date}. … | Le {date}, {name} a demandé la clôture de cet incident. Il sera clôturé lorsqu'une deuxième personne aura validé cette clôture. | «la clôture… le 25 nov.» can read as the date of closure |
| 12 | `publicReport.privacy` | …un code vous permet de revenir lire la réponse de l'hôpital. | …un code de suivi vous permet de revenir lire toute réponse de l'hôpital. | Names the code as the card does; does not promise a reply |
| 13 | `publicReport.tooMany` | …Ce que vous avez écrit est toujours là. Vous pourrez réessayer {when}. | …celle-ci n'a pas été envoyée. Gardez cette page ouverte : ce que vous avez écrit est toujours là. Vous pourrez réessayer {when}. | As Arabic row 14 |
| 14 | `followUp.lost` | Un code perdu ne peut être ni retrouvé ni remplacé. | Un code perdu ne peut être ni retrouvé ni remplacé. Votre déclaration, elle, a bien été reçue. | As Arabic row 15 |
| 15 | `incidents.code.keepSafe` | …peut lire les réponses à cette déclaration et écrire… | Toute personne qui détient ce code peut lire cette déclaration et les réponses, et écrire des commentaires en tant que déclarant. Ne le communiquez à personne. | As Arabic row 16 |
| 16 | `followUp.wrong` | Ce code n'ouvre aucune déclaration. Comparez-le à ce que vous avez noté, puis réessayez. | …puis réessayez. Un code ne contient jamais 0, 1, I, L ni O. | As Arabic row 17 |
| 17 | `admin.permissions.incidents.sign_off` | Valider les clôtures qui exigent une deuxième personne | Valider les clôtures qui exigent l'accord d'une deuxième personne | Optional. "Closures that require a second person" is elliptical |

**Depend on a decision:** `publicReport.description`, the rest of `publicReport.poster`, `incidents.code.later`.

**Spacing:** clean across all of `fr.json` (U+00A0 before every `:` and inside every « », U+202F before every `; ? !`).

## English (10 changes, 3 more that depend on a decision)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `incidents.detail.reporterHidden` | Seen only by the quality team | Only the quality team can see this | As Arabic row 2 |
| 2 | `incidents.form.whoSeesName` | Your name is saved with this report. Only the quality team… | If you leave this box unticked, your name is saved with the report. Only the quality team can see it: everyone else who works on the report sees “The reporter” in its place. | As Arabic row 3 |
| 3 | `publicReport.unavailable` | …ask the hospital's quality team how. | This link is not in use. To report an incident, speak to a member of staff or to the hospital's quality team. | Ends on a dangling "how"; no reachable person |
| 4 | `incidents.detail.awaiting` | {name} asked for this incident to be closed on {date}. … | On {date}, {name} asked for this incident to be closed. It closes when a second person signs it off. | "To be closed on {date}" reads as the closing date |
| 5 | `publicReport.privacy` | …you get a code to come back and read the hospital's reply. | …After sending, you get a follow-up code to come back and read any reply from the hospital. | As Arabic row 13 |
| 6 | `publicReport.tooMany` | …What you wrote is still here. You can try again {when}. | …so this one was not sent. Keep this page open: what you wrote is still here. You can try again {when}. | As Arabic row 14 |
| 7 | `followUp.lost` | A lost code cannot be recovered or replaced. | A lost code cannot be recovered or replaced. Your report itself has still been received. | As Arabic row 15 |
| 8 | `incidents.code.keepSafe` | …can read the replies to this report and write… | Anyone who has this code can read this report and the replies to it, and write comments as its reporter. Keep it to yourself. | As Arabic row 16 |
| 9 | `followUp.wrong` | This code does not open a report. Check it against what you wrote down, then try again. | …then try again. A code never contains 0, 1, I, L or O. | As Arabic row 17 |
| 10 | `admin.settings.reporting.shows` | …It shows no incident. | …It does not show any incidents. | Optional. Stiff |

## Two new keys (all three languages)

| Key | Why | en | ar | fr |
|---|---|---|---|---|
| `followUp.behind` | `follow-up.tsx:274` reuses `incidents.detail.behind`, which says "Reload the page". On this page a reload throws the report away and asks for the code again, and it does not say the comment went through | Your comment was sent, but this page could not be updated. To see the latest, finish and open the report again with your code. | أُرسل تعليقك، لكن تعذّر تحديث هذه الصفحة. لرؤية آخر التغييرات، اخرج ثم افتح البلاغ من جديد برمز المتابعة. | Votre commentaire a été envoyé, mais cette page n'a pas pu être actualisée. Pour voir les dernières modifications, quittez puis rouvrez la déclaration avec votre code. |
| `publicReport.notSent` | `public-report.tsx:99` shows `unavailable` under the form when reporting is switched off while someone is writing. It never says the report was not sent | Your report was not sent: this link has just stopped taking reports. Speak to a member of staff or to the hospital's quality team. | لم يُرسَل بلاغك: توقّف هذا الرابط عن استقبال البلاغات للتو. تحدّث إلى أحد موظفي المستشفى أو إلى فريق الجودة. | Votre déclaration n'a pas été envoyée : ce lien vient d'être mis hors service. Adressez-vous à un membre du personnel ou à l'équipe qualité de l'hôpital. |

---

## Layout faults

| Screenshot | Fault | Fix |
|---|---|---|
| `ar-390-public-sent.png`, `ar-1280-report-sent-anonymous.png` | **The code can be copied in the wrong order.** At 390 it is a 2×2 grid of Latin groups with no hyphens on a right-to-left page; an Arabic reader starts each row at the right and writes B95Z before B5B4. At 1280 it is four groups about 130 px apart, read as four separate items from the right. A code written down wrongly cannot be recovered | `follow-up-code.tsx:36-44`: show one left-to-right string with its hyphens, as it is copied and as the follow-up placeholder shows it: `groups.join("-")` in a `dir="ltr"` paragraph with `text-center text-xl whitespace-nowrap tracking-wide min-[30rem]:text-2xl` in place of the grid classes. In a scratch render the 19 characters fit a 390 px screen at 20 px |
| `ar-390-public-form.png`, `ar-390-public-form-filled.png`, `ar-390-public-too-many.png`, `ar-1280-public-form.png`, `ar-390-report-form-anonymous.png`, `ar-1280-list-ltr-inputs.png` | **Date and date-time fields still sit at the left edge**, away from their label. The `globals.css:67` rule works on text fields but not here: Tailwind's reset makes `::-webkit-datetime-edit` an inline flex box, which ignores `text-align` | Add `[dir="rtl"] input[dir="ltr"]::-webkit-datetime-edit { justify-content: flex-end; }` beside the existing rule. I reproduced the fault and this fix in headless Chrome on a scratch file only; not checked in the app, Safari or Firefox |
| `ar-390-report-form-named.png` (also `fr-390-report-form-named.png`, not opened) | "Your name is saved…" sits under the "Report anonymously" label | Wording: Arabic row 3, French row 9, English row 2 |
| `ar-390-list-open-serious.png`, `fr-390-list-open-serious.png` | A separator dot is left at the end of a line before «القسم المعني بالمعالجة» / the handling department | `incidents-list.tsx:457-504`: keep each dot in the same `inline-block` span as the piece that follows it |
| `ar-390-public-form.png`, `fr-390-public-form.png` | The preselected place reads «— — وحدة العناية المركزة»: the tree indent shows as two dashes to a visitor | Low. Drop the indent on the public form, or use an option group per facility |
| `incidents-list.tsx:248` (read, not seen) | What "Serious only" means is only a `title` tooltip, so it never shows on a phone or to a keyboard user | Low. Show `seriousHelp` as small text, as the dashboard tile does |
| `en-1280-awaiting-reporter-view.png` | The reporter's view shows the note a request was withdrawn with, while `noteHelpInternal` says the reporter cannot read it | Probably stale: the shot is from 08:08 and `incidents.service.ts:1072-1077` now withholds that note. Retake it to be sure |
| `ar-1280-timeline-sign-off.png`, `ar-390-report-form-*.png` | Sidebar ends at 900 px; top bar drawn across the middle of the page | Full-page capture artefacts; not judged |

**Right-to-left checks that passed**
- **Follow-up page:** label at the right, the left-to-right field and its placeholder aligned under it, typed code aligned the same way (`ar-390-follow-up-entry.png`, `ar-390-follow-up-typed.png`).
- **Left-to-right text fields:** aligned to the end on the login, reference search and unit code fields (`ar-390-login-ltr-inputs.png`, `ar-1280-list-ltr-inputs.png`, `ar-1280-org-new-ltr-code.png`).
- **Mixed direction:** an English note inside the Arabic timeline keeps its full stop at the correct end; «رمز QR» and "Trustline" sit correctly inside Arabic sentences; the code and the links are never placed inside an Arabic sentence.
- **Links and buttons:** addresses are `dir="ltr"` and wrap cleanly at 390; copy buttons sit at the start side; the external-link and arrow icons are mirrored.
- **Timeline:** the "from → to" arrow stays with its new value in Arabic and French (`fr-390-timeline-sign-off.png`).
- **Poster** (`unit-poster.pdf`): each line carries its own language and direction, names and instruction centred, order follows the hospital's default language.
- **Code:** no physical classes, no language branching, no wording in markup in any changed file.

---

## Summary

**Counts:** Arabic 20, French 17, English 10, plus 2 new keys in all three and 3 strings per language that wait on decisions. Layout: 2 faults that matter, 4 small ones.

**Checks you asked for**
- **Review 2:** every row of the three tables is in the dictionaries as I wrote it: option A, the named noun in "(inactive)", the clock figure, `reportedJustNow`, the arrow kept with its value, `<bdi>` and isolates on unit names. The one gap is the alignment rule on date fields (above).
- **Parity:** 636 keys in each file, none missing or empty, placeholders identical, no Arabic-Indic digits.
- **Facts:** nothing contradicts the six facts except `reporterHidden`, which leans towards "there is a name". The sign-off wording never says "because it is a sentinel event".

**Vocabulary**
- **«الاعتماد» / « validation »: confirmed**, on condition that Arabic always says «اعتماد الإغلاق» (rows 7 to 10).
- **«رمز المتابعة» / « code de suivi »: confirmed.** Use the full term in `publicReport.privacy`.
- **«المبلّغ» / « Le déclarant »: confirmed.**
- **«أحد موظفي المستشفى» / « Personnel de l'hôpital »: confirmed.**
- **"Quality team": confirmed** as the name; see decision 2 for the promise attached to it.

**The three that matter most**
1. **The follow-up code layout.** An Arabic reader can write the four groups down in the wrong order, and a wrong code is gone for good. Show it as one hyphenated left-to-right string.
2. **Public wording that leaves the reader stuck or alarmed.**
   - «إنهاء وإخفاء البلاغ» / « Terminer et masquer la déclaration » reads as ending the report.
   - The "not available" page sends a visitor to a quality team they cannot find.
   - The French poster says «Aucune connexion n'est nécessaire».
   - The follow-up page says "Reload the page" where a reload discards the report.
3. **Names inserted into sentences break agreement again**, on screens every handler sees: «طلب نورة الجودة إغلاق…», «ويكون وحدة العناية المركزة محدَّدًا», «avec Unité de soins intensifs déjà sélectionné».

**Needs a decision, not a fix**
1. **Nothing on the public form says what to do if it is urgent.** A relative may expect an immediate response. Suggested `publicReport.urgent`, also worth showing with the "too many" message:
   - en: "This form is not watched around the clock. If someone is in danger now, tell a member of staff straight away."
   - ar: «هذا النموذج لا يُتابَع على مدار الساعة. إذا كان أحد في خطر الآن فأخبِر أحد الموظفين فورًا.»
   - fr: «Ce formulaire n'est pas suivi en continu. Si quelqu'un est en danger maintenant, prévenez tout de suite un membre du personnel.»
2. **"Only the quality team can see it" is a promise the product does not enforce.** The built-in Administrator role holds `incidents.see_reporter`, and an administrator can give it to any role (`apps/api/src/identity/permissions.ts`). Either restrict who may hold it, or reword to something that stays true.
3. **Anonymity has one honest limit the form does not state:** what the person writes, with the place and time, can identify them. One plain sentence after `publicReport.privacy` and `anonymousWarning` would cover it:
   - en: "The hospital knows about you only what you write here."
   - ar: «لا يعرف المستشفى عنك إلا ما تكتبه هنا.»
   - fr: «L'hôpital ne sait de vous que ce que vous écrivez ici.»
4. **The code card says "open the follow-up page" but gives no address to keep.** The page is linked only from this card (shown once), the foot of the public form, and Settings. Staff who report anonymously where public reporting is off have no other way back. Show the address in the card (`dir="ltr"`, with a copy button) and change `incidents.code.later`:
   - en: "To come back later, keep the address of the follow-up page with your code:"
   - ar: «للعودة لاحقًا، احتفظ بعنوان صفحة المتابعة مع الرمز:»
   - fr: «Pour revenir plus tard, conservez l'adresse de la page de suivi avec votre code :»
5. **«خلال 12 دقيقة».** It is correct Arabic and the sentence reads, but «خلال» also means "during" earlier in the same message, so it can be taken as "at some point in the next 12 minutes". A clock time removes the doubt and the plural forms in every language, with no language special-cased: fill `{time}` from `dateTimeFormat(lang, { hour: "numeric", minute: "2-digit" })`.
   - en: "You can try again after {time}."
   - ar: «يمكنك المحاولة مرة أخرى بعد الساعة {time}.»
   - fr: «Vous pourrez réessayer après {time}.»
6. **Plain words for the first line and the poster.** "Near miss" and "hazard" are jargon to a visitor; the three cards already explain them. The poster also leaves out the strongest reason to scan: no name is asked.
   - `publicReport.description`
     - en: "Tell the hospital about something that went wrong, nearly went wrong, or could cause harm. It takes about two minutes."
     - ar: «أخبِر المستشفى عن حدث غير مرغوب فيه وقع أو كاد يقع، أو عن وضع قد يسبّب ضررًا. يستغرق ذلك نحو دقيقتين.»
     - fr: «Un incident, un incident évité de justesse ou une situation dangereuse. Cela prend environ deux minutes.»
   - `publicReport.poster`
     - en: "Scan this code with your phone to report something that went wrong, nearly went wrong, or is unsafe. No sign-in, and you are not asked for your name."
     - ar: «امسح هذا الرمز بهاتفك للإبلاغ عن حادث وقع أو كاد يقع، أو عن وضع غير آمن. دون تسجيل دخول، ودون ذكر اسمك.»
     - fr: «Scannez ce code avec votre téléphone pour déclarer un incident, un incident évité de justesse ou une situation dangereuse. Sans compte, et sans donner votre nom.»
7. **The public form reuses staff wording and staff errors.** "Category", "Harm level" and "What was done immediately" are quality-department labels. Three errors a public reporter can receive (`unknown_category`, `unknown_org_unit`, `harm_not_applicable`) say "Reload the page", which on this form throws away everything they wrote.

**Screens opened and screens only read**
- **Opened, 37 of 86 plus the poster PDF.**
  - Arabic, 25 of 32: every 390 shot, and at 1280 the public form, follow-up view, settings, sign-off timeline, anonymous sent screen, list with left-to-right inputs and new-unit code.
  - French, 9 of 14: public form, "too many", follow-up entry and view, settings, sign-off timeline, unit reporting, list, reporter-hidden detail.
  - English, 3 of 40: `en-1280-awaiting-reporter-view`, `en-390-follow-up-wrong`, `en-1280-sign-off-request-form`.
- **Not opened:**
  - Arabic at 1280: awaiting second person, dashboard, follow-up entry and typed, list open-serious, org tree, unit reporting.
  - French: awaiting second person, dashboard, public unavailable, both signed-in report forms.
  - English: the other 37.
- **No screenshot exists, dictionary only:**
  - The French sent screen with the code card (you asked for it; there is no `fr-*-sent` shot).
  - In Arabic and French: follow-up "wrong code" and "too many", role permissions, the `same_person` error, the sign-off request form, the signed-off and withdrawn states, and settings switched off.

**Files**
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `ar.json`, `fr.json`
- `/home/user/Trustline/apps/web/src/components/incidents/follow-up-code.tsx` (code layout, lines 36-44; `later`, line 66)
- `/home/user/Trustline/apps/web/src/app/globals.css` (alignment rule, line 67)
- `/home/user/Trustline/apps/web/src/components/public/follow-up.tsx` (line 274)
- `/home/user/Trustline/apps/web/src/components/public/public-report.tsx` (line 99)
- `/home/user/Trustline/apps/web/src/components/incidents/report-fields.tsx` (date field, line 229; name text under the tick box, lines 294-297)
- `/home/user/Trustline/apps/web/src/components/admin/unit-reporting.tsx` (line 41)
- `/home/user/Trustline/apps/web/src/components/incidents/incident-detail.tsx` (line 120)
- `/home/user/Trustline/apps/web/src/components/incidents/incidents-list.tsx` (lines 248, 457-504)
- Scratch renders for the two layout fixes: `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour/t.png` and `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour/t2.png`