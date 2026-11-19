/**
 * Languages for the strings a person actually meets.
 *
 * Scope, stated honestly: the CLI's tagline and help header, first-run messages,
 * the errors a beginner hits, and the dashboard's four headline labels plus its
 * attention sentence. Everything else — the detail tables, the numeric foot lines,
 * provider and model names — stays in English, because those are identifiers or
 * numbers, and a translated identifier is harder to read than an English one.
 *
 * docs/LANGUAGES.md carries the exact boundary. A key is either fully translated
 * in a language or it falls back to English whole; a test enforces that every
 * language translates the same key set with the same placeholders.
 *
 * `SUI_LANG` (or `locale` in the config) selects a language. Anything unknown
 * falls back to English rather than throwing — a typo in a language code must not
 * stop the gateway from starting.
 */

/** Right-to-left scripts need a direction, not just a translation. */
export const RTL = new Set(['ur']);

export const LANGUAGES = {
  en: 'English',
  hi: 'हिन्दी',
  gu: 'ગુજરાતી',
  mr: 'मराठी',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  bn: 'বাংলা',
  kn: 'ಕನ್ನಡ',
  ml: 'മലയാളം',
};

/** @type {Record<string, Record<string, string>>} */
export const STRINGS = {
  en: {
    'app.tagline': 'one endpoint for every LLM',
    'help.commands': 'Commands',
    'help.flags': 'Flags',
    'first.looking': 'Looking for provider keys on this machine…',
    'first.found': 'Found a key for {provider}.',
    'first.none': 'No provider keys found. Set one and run this again.',
    'first.demo': 'No key found, so this run uses the demo provider.',
    'first.ready': 'Endpoint ready',
    'first.start': 'Start it with: {command}',
    'err.no_config': 'No sui config found. Run `{command}` init to create one, or pass --config <file>.',
    'err.port_in_use': 'Port {port} is already in use. Either stop what is on it, or start sui elsewhere: {command} start --port {next}',
    'err.no_keys_public': 'Refusing to serve on {host} with no API keys: anyone who can reach this port could spend your quota.',
    'err.overloaded': 'This gateway is at capacity. Try again in a moment.',
    'glance.turns': 'turns today',
    'glance.spent': 'spent today',
    'glance.verified': 'verified routes',
    'glance.p95': 'p95 latency',
    'glance.ok': 'Everything is answering.',
    'glance.attention': 'Needs attention',
    'glance.nothing_verified': 'nothing is verified yet',
    'budget.today': 'Budget today',
    'budget.within': 'Within budget',
    'probe.refused_local': 'refusing to probe a loopback address — use `sui local` for a model on this machine',
    'probe.wrote': 'Wrote {count} verification(s)',
    'catalog.summary': '{total} catalogue entries · {routable} routable',
    'freebudget.verified': 'verified per month',
    'freebudget.unverified': 'published, unverified',
  },
  hi: {
    'app.tagline': "हर LLM के लिए एक एंडपॉइंट",
    'help.commands': "कमांड्स",
    'help.flags': "फ्लैग्स",
    'first.looking': "इस मशीन पर प्रोवाइडर कीज़ खोज रहे हैं…",
    'first.found': "{provider} के लिए एक की मिली।",
    'first.none': "कोई प्रोवाइडर कीज़ नहीं मिलीं। एक सेट करें और इसे फिर से चलाएं।",
    'first.demo': "कोई की नहीं मिली, इसलिए यह रन डेमो प्रोवाइडर का उपयोग करता है।",
    'first.ready': "एंडपॉइंट तैयार है",
    'first.start': "इसे इस कमांड से शुरू करें: {command}",
    'err.no_config': "कोई sui कॉन्फ़िग नहीं मिली। एक बनाने के लिए `{command}` init चलाएं, या --config <file> पास करें।",
    'err.port_in_use': "पोर्ट {port} पहले से ही उपयोग में है। या तो वहां चल रहे काम को रोकें, या कहीं और sui शुरू करें: {command} start --port {next}",
    'err.no_keys_public': "बिना API कीज़ के {host} पर सर्व करने से मना किया जा रहा है: जो कोई भी इस पोर्ट तक पहुंच सकता है, वह आपका कोटा खर्च कर सकता है।",
    'err.overloaded': "यह गेटवे क्षमता पर है। थोड़ी देर में फिर से प्रयास करें।",
    'glance.turns': "आज के टर्न्स",
    'glance.spent': "आज का खर्च",
    'glance.verified': "सत्यापित रूट्स",
    'glance.p95': "p95 लेटेंसी",
    'glance.ok': "सब कुछ जवाब दे रहा है।",
    'glance.attention': "ध्यान देने की आवश्यकता है",
    'glance.nothing_verified': "अभी तक कुछ भी सत्यापित नहीं हुआ है",
    'budget.today': "आज का बजट",
    'budget.within': "बजट के भीतर",
    'probe.refused_local': "लूपबैक एड्रेस को प्रोब करने से मना किया जा रहा है — इस मशीन पर मॉडल के लिए `sui local` का उपयोग करें",
    'probe.wrote': "{count} सत्यापन(स) लिखे गए",
    'catalog.summary': "{total} कैटलॉग प्रविष्टियां · {routable} राउटेबल",
    'freebudget.verified': "प्रति माह सत्यापित",
    'freebudget.unverified': "प्रकाशित, असत्यापित",
  },
  gu: {
    'app.tagline': "દરેક LLM માટે એક એન્ડપોઇન્ટ",
    'help.commands': "કમાન્ડ્સ",
    'help.flags': "ફ્લેગ્સ",
    'first.looking': "આ મશીન પર પ્રોવાઇડરની કીઝ શોધી રહ્યા છીએ…",
    'first.found': "{provider} માટે એક કી મળી.",
    'first.none': "કોઈ પ્રોવાઇડર કીઝ મળી નથી. એક સેટ કરો અને આને ફરીથી રન કરો.",
    'first.demo': "કોઈ કી મળી નથી, તેથી આ રન ડેમો પ્રોવાઇડરનો ઉપયોગ કરે છે.",
    'first.ready': "એન્ડપોઇન્ટ તૈયાર છે",
    'first.start': "આની સાથે શરૂ કરો: {command}",
    'err.no_config': "કોઈ sui કન્ફિગ મળી નથી. એક બનાવવા માટે `{command}` init રન કરો, અથવા --config <file> પાસ કરો.",
    'err.port_in_use': "પોર્ટ {port} પહેલેથી જ ઉપયોગમાં છે. કાં તો તેના પર જે છે તેને બંધ કરો, અથવા બીજે ક્યાંક sui શરૂ કરો: {command} start --port {next}",
    'err.no_keys_public': "કોઈ API કીઝ વિના {host} પર સર્વ કરવાનો ઇનકાર કરી રહ્યા છીએ: જે કોઈ આ પોર્ટ સુધી પહોંચી શકે તે તમારી ક્વોટા વાપરી શકે છે.",
    'err.overloaded': "આ ગેટવે ક્ષમતા પર છે. થોડી વારમાં ફરીથી પ્રયાસ કરો.",
    'glance.turns': "આજે ટર્ન થયા",
    'glance.spent': "આજે ખર્ચાયા",
    'glance.verified': "ચકાસાયેલા રૂટ્સ",
    'glance.p95': "p95 લેટન્સી",
    'glance.ok': "બધું જવાબ આપી રહ્યું છે.",
    'glance.attention': "ધ્યાન આપવાની જરૂર છે",
    'glance.nothing_verified': "હજુ સુધી કંઈ ચકાસાયેલ નથી",
    'budget.today': "આજે બજેટ",
    'budget.within': "બજેટ મુજબ",
    'probe.refused_local': "લૂપબેક એડ્રેસ પર પ્રોબ કરવાનો ઇનકાર કરી રહ્યા છીએ — આ મશીન પરના મોડલ માટે `sui local` નો ઉપયોગ કરો",
    'probe.wrote': "{count} વેરિફિકેશન(ઓ) લખાયા",
    'catalog.summary': "{total} કેટેલોગ એન્ટ્રીઓ · {routable} રાઉટેબલ",
    'freebudget.verified': "દર મહિને ચકાસાયેલ",
    'freebudget.unverified': "પ્રકાશિત, અસત્યાપિત",
  },
  mr: {
    'app.tagline': "प्रत्येक LLM साठी एक एंडपॉइंट",
    'help.commands': "कमांड्स",
    'help.flags': "फ्लॅग्स",
    'first.looking': "या मशीनवर प्रोव्हायडर कीज शोधत आहे...",
    'first.found': "{provider} साठी एक की सापडली.",
    'first.none': "कोणत्याही प्रोव्हायडर कीज सापडल्या नाहीत. एक सेट करा आणि पुन्हा रन करा.",
    'first.demo': "कोणतीही की सापडली नाही, त्यामुळे हा रन डेमो प्रोव्हायडर वापरतो.",
    'first.ready': "एंडपॉइंट तयार आहे",
    'first.start': "याने सुरू करा: {command}",
    'err.no_config': "कोणतीही sui कॉन्फिग सापडली नाही. एक तयार करण्यासाठी `{command}` init रन करा, किंवा --config <file> पास करा.",
    'err.port_in_use': "पोर्ट {port} आधीच वापरात आहे. एकतर त्यावर असलेले थांबवा, किंवा दुसरीकडे sui सुरू करा: {command} start --port {next}",
    'err.no_keys_public': "कोणत्याही API कीजशिवाय {host} वर सर्व्ह करण्यास नकार देत आहे: या पोर्टपर्यंत पोहोचू शकणारी कोणतीही व्यक्ती तुमचा कोटा खर्च करू शकते.",
    'err.overloaded': "या गेटवेची क्षमता पूर्ण झाली आहे. थोड्या वेळाने पुन्हा प्रयत्न करा.",
    'glance.turns': "आजचे टर्न्स",
    'glance.spent': "आजचा खर्च",
    'glance.verified': "व्हेरिफाय केलेले रूट्स",
    'glance.p95': "p95 लेटन्सी",
    'glance.ok': "सर्व काही उत्तर देत आहे.",
    'glance.attention': "लक्ष देण्याची गरज आहे",
    'glance.nothing_verified': "अद्याप काहीही व्हेरिफाय झालेले नाही",
    'budget.today': "आजचे बजेट",
    'budget.within': "बजेटमध्ये",
    'probe.refused_local': "लूपबॅक ॲड्रेस प्रोब करण्यास नकार देत आहे — या मशीनवरील मॉडेलसाठी `sui local` वापरा",
    'probe.wrote': "{count} व्हेरिफिकेशन(s) लिहिले",
    'catalog.summary': "{total} कॅटलॉग एंट्रीज · {routable} राउटेबल",
    'freebudget.verified': "प्रति महिना व्हेरिफाय केलेले",
    'freebudget.unverified': "प्रकाशित, अनव्हेरिफाय केलेले",
  },
  ta: {
    'app.tagline': "ஒவ்வொரு LLM-க்கும் ஒரு endpoint",
    'help.commands': "கமாண்டுகள்",
    'help.flags': "கொடிக்குறிகள்",
    'first.looking': "இந்த மெஷினில் provider keys-ஐ தேடுகிறோம்…",
    'first.found': "{provider}-க்கான ஒரு key கிடைத்துள்ளது.",
    'first.none': "எந்த provider keys-உம் கிடைக்கவில்லை. ஒன்றை அமைத்துவிட்டு மீண்டும் இதை இயக்கவும்.",
    'first.demo': "Key கிடைக்கவில்லை, எனவே இந்த இயக்கம் demo provider-ஐ பயன்படுத்துகிறது.",
    'first.ready': "Endpoint தயாராக உள்ளது",
    'first.start': "இதைக் கொண்டு தொடங்கவும்: {command}",
    'err.no_config': "sui config எதுவும் கிடைக்கவில்லை. ஒன்றை உருவாக்க `{command}` init-ஐ இயக்கவும், அல்லது --config <file> என்பதை வழங்கவும்.",
    'err.port_in_use': "Port {port} ஏற்கனவே பயன்பாட்டில் உள்ளது. அதில் உள்ளதை நிறுத்தவும், அல்லது வேறு இடத்தில் sui-ஐ தொடங்கவும்: {command} start --port {next}",
    'err.no_keys_public': "API keys இல்லாமல் {host}-இல் சேவை செய்ய மறுக்கிறது: இந்த port-ஐ அடையக்கூடிய எவரும் உங்கள் quota-வை செலவழிக்கலாம்.",
    'err.overloaded': "இந்த gateway முழு கொள்ளளவை எட்டியுள்ளது. சிறிது நேரத்தில் மீண்டும் முயற்சிக்கவும்.",
    'glance.turns': "இன்றைய திருப்பங்கள்",
    'glance.spent': "இன்றைய செலவு",
    'glance.verified': "சரிபார்க்கப்பட்ட வழிகள்",
    'glance.p95': "p95 latency",
    'glance.ok': "எல்லாம் பதிலளிக்கிறது.",
    'glance.attention': "கவனம் தேவை",
    'glance.nothing_verified': "இன்னும் எதுவும் சரிபார்க்கப்படவில்லை",
    'budget.today': "இன்றைய பட்ஜெட்",
    'budget.within': "பட்ஜெட்டிற்குள் உள்ளது",
    'probe.refused_local': "loopback முகவரியை ஆராய மறுக்கிறது — இந்த மெஷினில் உள்ள ஒரு மாடலுக்கு `sui local`-ஐப் பயன்படுத்தவும்",
    'probe.wrote': "{count} சரிபார்ப்பு(கள்) எழுதப்பட்டது",
    'catalog.summary': "{total} catalogue உள்ளீடுகள் · {routable} routable",
    'freebudget.verified': "மாதத்திற்கு சரிபார்க்கப்பட்டது",
    'freebudget.unverified': "வெளியிடப்பட்டது, சரிபார்க்கப்படாதது",
  },
  te: {
    'app.tagline': "ప్రతి LLM కి ఒక ఎండ్‌పాయింట్",
    'help.commands': "కమాండ్స్",
    'help.flags': "ఫ్లాగ్స్",
    'first.looking': "ఈ మెషీన్‌లో ప్రొవైడర్ కీస్ కోసం వెతుకుతోంది…",
    'first.found': "{provider} కోసం ఒక కీ దొరికింది.",
    'first.none': "ప్రొవైడర్ కీస్ ఏవీ కనుగొనబడలేదు. ఒకటి సెట్ చేసి మళ్లీ రన్ చేయండి.",
    'first.demo': "కీ దొరకలేదు, కాబట్టి ఈ రన్ డెమో ప్రొవైడర్‌ను ఉపయోగిస్తుంది.",
    'first.ready': "ఎండ్‌పాయింట్ సిద్ధంగా ఉంది",
    'first.start': "దీన్ని దీనితో ప్రారంభించండి: {command}",
    'err.no_config': "sui కాన్ఫిగ్ కనుగొనబడలేదు. ఒకదాన్ని సృష్టించడానికి `{command}` init ని రన్ చేయండి, లేదా --config <file> ని పాస్ చేయండి.",
    'err.port_in_use': "పోర్ట్ {port} ఇప్పటికే వాడుకలో ఉంది. దానిపై ఉన్నదాన్ని ఆపండి, లేదా వేరే చోట sui ని ప్రారంభించండి: {command} start --port {next}",
    'err.no_keys_public': "API కీలు లేకుండా {host} పై సేవ చేయడానికి నిరాకరిస్తోంది: ఈ పోర్ట్‌ను చేరుకోగల ఎవరైనా మీ కోటాను ఖర్చు చేయవచ్చు.",
    'err.overloaded': "ఈ గేట్‌వే సామర్థ్యానికి చేరుకుంది. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.",
    'glance.turns': "ఈ రోజు టర్న్స్",
    'glance.spent': "ఈ రోజు ఖర్చు",
    'glance.verified': "వెరిఫై చేయబడిన రూట్స్",
    'glance.p95': "p95 లేటెన్సీ",
    'glance.ok': "అంతా స్పందిస్తోంది.",
    'glance.attention': "శ్రద్ధ అవసరం",
    'glance.nothing_verified': "ఇంకా ఏదీ వెరిఫై చేయబడలేదు",
    'budget.today': "ఈ రోజు బడ్జెట్",
    'budget.within': "బడ్జెట్ లోపే ఉంది",
    'probe.refused_local': "లూప్‌బ్యాక్ అడ్రస్‌ను ప్రోబ్ చేయడానికి నిరాకరిస్తోంది — ఈ మెషీన్‌లోని మోడల్ కోసం `sui local` ని ఉపయోగించండి",
    'probe.wrote': "{count} వెరిఫికేషన్(లు) రాయబడింది",
    'catalog.summary': "{total} కేటలాగ్ ఎంట్రీలు · {routable} రూటబుల్",
    'freebudget.verified': "నెలకు వెరిఫై చేయబడింది",
    'freebudget.unverified': "పబ్లిష్ చేయబడింది, వెరిఫై చేయబడలేదు",
  },
};

/**
 * Look up a string. `{name}` placeholders are filled from `vars`.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @param {{locale?: string}} [opts]
 * @returns {string}
 */
export function t(key, vars = {}, opts = {}) {
  const locale = normaliseLocale(opts.locale ?? process.env.SUI_LANG ?? 'en');
  const table = STRINGS[locale] ?? STRINGS.en;
  // a key missing from a language falls back to English, never to the key name:
  // `err.no_config` in the middle of a sentence is worse than English
  const raw = table[key] ?? STRINGS.en[key] ?? key;
  return String(raw).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
}

/** `hi-IN` and `HI` both mean `hi`; anything unknown means `en`. */
export function normaliseLocale(value) {
  const code = String(value ?? 'en').toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(STRINGS, code) ? code : 'en';
}

/**
 * Which way does this locale read?
 *
 * Direction is a property of the language, not of whether this build ships its
 * strings: Urdu reads right-to-left even on a build that falls back to English
 * for it, and telling a browser otherwise lays the page out backwards.
 */
export function direction(locale) {
  const code = String(locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  return RTL.has(code) ? 'rtl' : 'ltr';
}

/** Every language this build ships. */
export function availableLocales() {
  return Object.keys(STRINGS).map((code) => ({ code, name: LANGUAGES[code] ?? code, dir: direction(code) }));
}
