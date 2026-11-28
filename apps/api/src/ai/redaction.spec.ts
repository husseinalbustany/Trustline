import { fold, NameIndex, Redaction } from './redaction.js';

/** A redaction over these names, and a helper that redacts one text. */
function redactor(names: string[]) {
  const redaction = new Redaction(new NameIndex(names));
  return { redaction, redact: (text: string) => redaction.redact(text) };
}

/** Redacts a text and puts it back: what the person reads is what they wrote. */
function roundTrip(names: string[], text: string) {
  const { redaction, redact } = redactor(names);
  const sent = redact(text);
  expect(redaction.restore(sent)).toBe(text);
  return sent;
}

describe('folding for comparison', () => {
  it('drops accents, Arabic diacritics and the tatweel, and writes every digit in Latin', () => {
    expect(fold('Hélène Çelik').text).toBe('helene celik');
    expect(fold('مُحَمَّد').text).toBe('محمد');
    expect(fold('محـــمد').text).toBe('محمد');
    expect(fold('أحمد إبراهيم آمنة').text).toBe('احمد ابراهيم امنه');
    expect(fold('٠٥٠١٢٣٤٥٦٧ ۱۲۳').text).toBe('0501234567 123');
  });

  it('keeps alef maqsura apart from yeh, so the preposition is not the name', () => {
    expect(fold('على').text).not.toBe(fold('علي').text);
  });

  it('says where each folded character came from', () => {
    const f = fold('مُحَمَّد X');
    expect(f.text).toBe('محمد x');
    expect(f.from[f.text.indexOf('x')]).toBe('مُحَمَّد X'.indexOf('X'));
  });
});

describe('names of people, in English', () => {
  const staff = ['Sarah Johnson', 'Khalid Al-Hassan', 'Will Turner'];

  it('replaces a whole name with a placeholder and puts it back', () => {
    const sent = roundTrip(staff, 'Sarah Johnson saw the fall at 10:30.');
    expect(sent).toBe('[PERSON_1] saw the fall at 10:30.');
  });

  it('replaces a name given in part: the first name or the surname alone', () => {
    const sent = roundTrip(staff, 'Johnson called Sarah, then Mr Turner.');
    expect(sent).not.toMatch(/Johnson|Sarah|Turner/);
    expect(sent).toMatch(/^\[PERSON_\d\] called \[PERSON_\d\], then Mr \[PERSON_\d\]\.$/);
  });

  it('gives the same name the same placeholder everywhere in the request', () => {
    const { redact } = redactor(staff);
    const a = redact('Sarah Johnson reported it.');
    const b = redact('Ask sarah johnson again.');
    expect(a).toBe('[PERSON_1] reported it.');
    expect(b).toBe('Ask [PERSON_1] again.');
  });

  it('matches Al- and El- names however the prefix is written', () => {
    for (const written of ['Khalid Al-Hassan', 'Khalid Al Hassan', 'Khalid al-Hassan', 'Khalid Alhassan', 'Khalid El-Hassan', 'Khalid El Hassan', 'KHALID AL-HASSAN']) {
      const sent = roundTrip(staff, `Seen by ${written} today.`);
      expect([written, sent]).toEqual([written, 'Seen by [PERSON_1] today.']);
    }
  });

  it('matches the surname with its prefix on its own, one person however spelled', () => {
    const { redaction, redact } = redactor(staff);
    const sent = redact('Dr Al-Hassan and Dr El Hassan agreed.');
    expect(sent).toBe('Dr [PERSON_1] and Dr [PERSON_1] agreed.');
    // Put back as first written.
    expect(redaction.restore(sent)).toBe('Dr Al-Hassan and Dr Al-Hassan agreed.');
  });

  it('does not take an ordinary word in lower case for a name', () => {
    const sent = roundTrip(staff, 'The nurse will turn the patient.');
    expect(sent).toBe('The nurse will turn the patient.');
  });

  it('removes a name passed in by the feature as well as the client’s users', () => {
    const sent = roundTrip([...staff, 'Jane Patient-Doe'], 'Jane Patient-Doe was given the wrong dose.');
    expect(sent).toBe('[PERSON_1] was given the wrong dose.');
  });

  it('matches Abdul and Abu names however they are spaced', () => {
    for (const written of ['Abdul Rahman', 'Abdulrahman', 'Abd al-Rahman', 'Abdel Rahman', 'Abdelrahman']) {
      const sent = roundTrip(['Abdulrahman Saleh'], `${written} Saleh signed.`);
      expect([written, sent]).toEqual([written, '[PERSON_1] signed.']);
    }
    expect(redactor(['Abu Bakr Nasser']).redact('Abou Bakr Nasser and Abubakr Nasser.')).toBe('[PERSON_1] and [PERSON_1].');
  });

  it('leaves titles alone, and takes the name a title announces for a name', () => {
    expect(roundTrip(['Dr Sarah Johnson'], 'Dr Smith and Dr Sarah Johnson.')).toBe('Dr [PERSON_1] and Dr [PERSON_2].');
  });
});

describe('names of people, in French', () => {
  const staff = ['Hélène Dubois', 'Jean-Luc Lefèvre', 'Pierre d’Artagnan'];

  it('matches with or without accents, and in capitals', () => {
    for (const written of ['Hélène Dubois', 'Helene Dubois', 'HÉLÈNE DUBOIS']) {
      const sent = roundTrip(staff, `Mme ${written} a signalé la chute.`);
      expect([written, sent]).toEqual([written, 'Mme [PERSON_1] a signalé la chute.']);
    }
  });

  it('matches hyphenated first names, and a name after an elision', () => {
    expect(roundTrip(staff, 'Le Dr Jean-Luc Lefèvre est arrivé.')).toBe('Le Dr [PERSON_1] est arrivé.');
    expect(roundTrip(staff, 'Selon Lefevre, rien.')).toBe('Selon [PERSON_1], rien.');
    expect(roundTrip(staff, 'M. d’Artagnan a vu.')).not.toMatch(/Artagnan/);
  });

  it('keeps the common words that are not capitalised', () => {
    expect(roundTrip(['Marie Blanc'], 'Le mur blanc a été nettoyé par Marie.')).toBe('Le mur blanc a été nettoyé par [PERSON_1].');
  });
});

describe('names of people, in Arabic', () => {
  const staff = ['محمد الحسن', 'فاطمة الزهراء علي', 'عبد الله سالم'];

  it('matches with and without diacritics', () => {
    for (const written of ['محمد الحسن', 'مُحَمَّد الحَسَن', 'محمّد الحسن', 'محـمد الحسن']) {
      const sent = roundTrip(staff, `أبلغ ${written} عن السقوط.`);
      expect([written, sent]).toEqual([written, 'أبلغ [PERSON_1] عن السقوط.']);
    }
  });

  it('matches a name written with or without hamza, and teh marbuta as heh', () => {
    expect(roundTrip(['أحمد إبراهيم'], 'حضر احمد ابراهيم.')).toBe('حضر [PERSON_1].');
    expect(roundTrip(staff, 'وصلت فاطمه الزهراء علي.')).toBe('وصلت [PERSON_1].');
  });

  it('matches عبد names joined or apart', () => {
    for (const written of ['عبد الله سالم', 'عبدالله سالم']) {
      expect([written, roundTrip(staff, `قال ${written} ذلك.`)]).toEqual([written, 'قال [PERSON_1] ذلك.']);
    }
  });

  it('keeps an attached conjunction or preposition outside the placeholder', () => {
    const sent = roundTrip(staff, 'تحدثت مع محمد الحسن ولمحمد الحسن ملاحظة.');
    expect(sent).toBe('تحدثت مع [PERSON_1] ول[PERSON_1] ملاحظة.');
    expect(roundTrip(staff, 'وفاطمة حاضرة.')).toBe('و[PERSON_1] حاضرة.');
    expect(roundTrip(staff, 'فلعبدالله سالم الحق.')).toBe('فل[PERSON_1] الحق.');
  });

  it('matches a part of a name on its own, in Arabic where there are no capitals', () => {
    const sent = roundTrip(staff, 'الحسن غائب اليوم.');
    expect(sent).toBe('[PERSON_1] غائب اليوم.');
  });

  it('does not take the preposition على for the name علي', () => {
    expect(roundTrip(staff, 'وقع المريض على الأرض.')).toBe('وقع المريض على الأرض.');
  });

  it('removes a name in mixed Arabic and English text', () => {
    const sent = roundTrip(['Sarah Johnson', 'محمد الحسن'], 'الممرضة Sarah Johnson أبلغت محمد الحسن.');
    expect(sent).toBe('الممرضة [PERSON_1] أبلغت [PERSON_2].');
  });
});

describe('identifiers', () => {
  const none: string[] = [];

  it('still removes a name that runs into an address', () => {
    const sent = roundTrip(['Sarah Johnson'], 'From Sarah Johnson@hospital.example today.');
    // The address takes what is joined to the @; the rest of the name is a name.
    expect(sent).toBe('From [PERSON_1] [EMAIL_1] today.');
  });

  it('replaces email addresses, even when they hold a name', () => {
    const sent = roundTrip(['Sarah Johnson'], 'Write to sarah.johnson@hospital.example or s.j@x.org.');
    expect(sent).toBe('Write to [EMAIL_1] or [EMAIL_2].');
  });

  it('replaces phone numbers in several forms, Latin and Arabic-Indic digits', () => {
    for (const written of ['+971 50 123 4567', '050-123-4567', '0501234567', '(04) 123 4567', '00961 3 123 456', '٠٥٠١٢٣٤٥٦٧', '+٩٧١ ٥٠ ١٢٣ ٤٥٦٧']) {
      const sent = roundTrip(none, `Call ${written} now.`);
      expect([written, sent]).toEqual([written, 'Call [PHONE_1] now.']);
    }
  });

  it('gives one number the same placeholder however it is spaced', () => {
    const { redact } = redactor(none);
    expect(redact('050 123 4567 and 0501234567')).toBe('[PHONE_1] and [PHONE_1]');
  });

  it('replaces national ID-like numbers', () => {
    expect(roundTrip(none, 'Emirates ID 784-1990-1234567-1.')).toBe('Emirates ID [ID_1].');
    expect(roundTrip(none, 'Iqama 2123456789 on file.')).toBe('Iqama [ID_1] on file.');
    expect(roundTrip(none, 'His ID 1012345678.')).toBe('His ID [ID_1].');
    expect(roundTrip(none, 'رقم الهوية ١٠١٢٣٤٥٦٧٨')).toBe('رقم الهوية [ID_1]');
    expect(roundTrip(none, 'Passport no. A1234567')).toBe('Passport no. [ID_1]');
    expect(roundTrip(none, 'Numéro de sécurité sociale 1 85 05 78 006 084 36')).toMatch(/sociale \[ID_1\]$/);
    expect(roundTrip(none, 'Civil ID 287654321012')).toBe('Civil ID [ID_1]');
  });

  it('replaces medical record-like numbers introduced as such, in each language', () => {
    expect(roundTrip(none, 'MRN 00123456 admitted.')).toBe('MRN [MRN_1] admitted.');
    expect(roundTrip(none, 'MRN: 4521 in bed 3.')).toBe('MRN: [MRN_1] in bed 3.');
    expect(roundTrip(none, 'Medical record number HX-55821.')).toBe('Medical record number [MRN_1].');
    expect(roundTrip(none, 'Dossier n° 778812, chambre 12.')).toBe('Dossier n° [MRN_1], chambre 12.');
    expect(roundTrip(none, 'رقم الملف ٤٥٢١٨ في الغرفة ٣')).toBe('رقم الملف [MRN_1] في الغرفة ٣');
    expect(roundTrip(none, 'الرقم الطبي: 99812')).toBe('الرقم الطبي: [MRN_1]');
  });

  it('leaves dates, times, doses, rooms and Trustline’s own references alone', () => {
    const text = 'On 2026-11-28 at 10:30, 5 mg in room 12, see INC-2026-0042 and POL-QA-001, 28.11.2026.';
    expect(roundTrip(none, text)).toBe(text);
  });

  it('replaces a long number standing alone, which can only be an identifier', () => {
    expect(roundTrip(none, 'Account 9876543210123 noted.')).toBe('Account [ID_1] noted.');
  });
});

describe('names nobody passed in (security review 13, H2)', () => {
  const staff = ['Mohammed Al-Rashid', 'Li Na', 'Jo Smith', 'Sarah Connor'];
  /** As AiService does: learn from every text, then redact. */
  const send = (texts: string[], names = staff) => {
    const redaction = new Redaction(new NameIndex(names));
    redaction.reserve(texts);
    redaction.learn(texts);
    const sent = texts.map((t) => redaction.redact(t));
    // Every placeholder made is put back (as first written).
    for (const s of sent) expect(redaction.restore(s)).not.toMatch(/\[(PERSON|EMAIL|PHONE|ID|MRN)_\d+\]/);
    return sent;
  };

  it('takes the capitalised words after a title or a relationship for a name, in English', () => {
    expect(send(['Patient Aisha Rahman (bed 4) fell; her son Omar called.'])).toEqual([
      'Patient [PERSON_1] (bed 4) fell; her son [PERSON_2] called.',
    ]);
    expect(send(['Mr. Brown and Mrs Ng were told. The witness, Peter Jones, agreed.'])).toEqual([
      'Mr. [PERSON_1] and Mrs [PERSON_2] were told. The witness, [PERSON_3], agreed.',
    ]);
    // Not when what follows is an ordinary word.
    expect(send(['The patient was moved; her son was told.'])).toEqual(['The patient was moved; her son was told.']);
  });

  it('removes a name it learned wherever else it appears in the request', () => {
    expect(send(['Patient Aisha Rahman fell.', 'Later Aisha said she slipped; aisha rahman is 80.'])).toEqual([
      'Patient [PERSON_1] fell.',
      'Later [PERSON_2] said she slipped; [PERSON_1] is 80.',
    ]);
  });

  it('does the same in French', () => {
    expect(send(['La patiente Hélène Dubois est tombée ; son fils Pierre a appelé. Mme Leroy était présente.'])).toEqual([
      'La patiente [PERSON_1] est tombée ; son fils [PERSON_2] a appelé. Mme [PERSON_3] était présente.',
    ]);
  });

  it('does the same in Arabic, with and without diacritics, stopping at words that cannot be a name', () => {
    expect(send(['سقطت المريضة عائشة رحمن في الغرفة، واتصل ابنها عمر.'])).toEqual([
      'سقطت المريضة [PERSON_1] في الغرفة، واتصل ابنها [PERSON_2].',
    ]);
    expect(send(['زوجته فاطِمة في المستشفى.'])).toEqual(['زوجته [PERSON_1] في المستشفى.']);
    expect(send(['المريض في الغرفة ٣.'])).toEqual(['المريض في الغرفة ٣.']);
  });

  it('matches a known name written in lower case, when long enough and not an ordinary word', () => {
    expect(send(['spoke to mohammed and sarah at 10.'])).toEqual(['spoke to [PERSON_1] and [PERSON_2] at 10.']);
    // Short or ordinary words stay.
    expect(send(['the nurse will mark it.'], ['Will Mark'])).toEqual(['the nurse will mark it.']);
  });

  it('matches common spellings of the same name', () => {
    const sent = send(['Muhammad Al-Rashid and Mohamed Al Rashid and Muhammed Alrashid.']);
    expect(sent).toEqual(['[PERSON_1] and [PERSON_1] and [PERSON_1].']);
    expect(send(['Aicha came, then Ayesha.'], ['Aisha Karim'])).toEqual(['[PERSON_1] came, then [PERSON_1].']);
  });

  it('matches a name with a short part when a title announces it', () => {
    expect(send(['Nurse Li gave the dose.'])).toEqual(['Nurse [PERSON_1] gave the dose.']);
  });

  it('sees through a soft hyphen or a zero-width character inside a name', () => {
    expect(send(['Sa\u00ADrah Con\u200Bnor was there.'])).toEqual(['[PERSON_1] was there.']);
  });

  it('takes a number of six digits or more near a word for a patient or a file for a record number', () => {
    expect(send(['patient 654321 and file 445566; dossier du patient : 778812; ملف ٤٥٢١٨٨'])).toEqual([
      'patient [MRN_1] and file [MRN_2]; dossier du patient : [MRN_3]; ملف [MRN_4]',
    ]);
    // A short number near the same words stays.
    expect(send(['patient in bed 12, file 4455'])).toEqual(['patient in bed 12, file 4455']);
  });
});

describe('putting back', () => {
  it('restores placeholders the model wrote, and leaves what only looks like one', () => {
    const { redaction, redact } = redactor(['Sarah Johnson']);
    redact('Sarah Johnson, 050 123 4567');
    expect(redaction.restore('[PERSON_1] should call [PHONE_1]; [PERSON_9] is unknown.')).toBe(
      'Sarah Johnson should call 050 123 4567; [PERSON_9] is unknown.',
    );
  });

  it('restores a placeholder written without brackets or with spaces', () => {
    const { redaction, redact } = redactor(['Sarah Johnson']);
    redact('Sarah Johnson');
    expect(redaction.restore('Ask PERSON_1, or [ PERSON_1 ].')).toBe('Ask Sarah Johnson, or Sarah Johnson.');
  });

  it('never puts a name back where someone typed a placeholder without brackets (security review 13, M2)', () => {
    const { redaction } = redactor(['Sarah Connor', 'Fatima Zahra']);
    const texts = ['Sarah Connor met Fatima Zahra. Note: PERSON_2 is the code of ward 7, [ PERSON_3 ] too.'];
    redaction.reserve(texts);
    const sent = redaction.redact(texts[0]);
    expect(sent).toBe('[PERSON_1] met [PERSON_4]. Note: PERSON_2 is the code of ward 7, [ PERSON_3 ] too.');
    expect(redaction.restore(sent)).toBe(texts[0]);
  });

  it('never reuses a placeholder someone typed in the request', () => {
    const { redaction } = redactor(['Sarah Johnson']);
    const texts = ['Template: [PERSON_1] signs here.', 'Sarah Johnson signs.'];
    redaction.reserve(texts);
    const [a, b] = texts.map((t) => redaction.redact(t));
    expect(a).toBe('Template: [PERSON_1] signs here.');
    expect(b).toBe('[PERSON_2] signs.');
    expect(redaction.restore('[PERSON_1] and [PERSON_2]')).toBe('[PERSON_1] and Sarah Johnson');
  });

  it('restores every string inside a structured answer', () => {
    const { redaction, redact } = redactor(['محمد الحسن']);
    redact('محمد الحسن');
    expect(redaction.restoreDeep({ summary: 'اتصل بـ [PERSON_1]', items: ['[PERSON_1]', 3], nested: { who: '[PERSON_1]' } })).toEqual({
      summary: 'اتصل بـ محمد الحسن',
      items: ['محمد الحسن', 3],
      nested: { who: 'محمد الحسن' },
    });
  });

  it('keeps nothing but in the object of the request', () => {
    const a = redactor(['Sarah Johnson']);
    a.redact('Sarah Johnson');
    const b = redactor(['Sarah Johnson']);
    expect(b.redaction.restore('[PERSON_1]')).toBe('[PERSON_1]');
    expect(a.redaction.replaced).toBe(1);
  });
});
