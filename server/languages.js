import deepl from './deepl-languages.json' with { type: 'json' };
import google from './google-languages.json' with { type: 'json' };
import azure from './azure-languages.json' with { type: 'json' };
import jigsawstack from './jigsaw-languages.json' with { type: 'json' };
import assembly from './assembly-languages.json' with { type: 'json' };

// Provider catalogs checked against primary documentation/APIs on 2026-10-13.
export const TRANSLATION_LANGUAGES = { google, azure, jigsawstack, deepl };
export const ASSEMBLY_LANGUAGES = assembly;
export const LANGUAGE_CATALOG = { ...deepl, ...assembly, ...azure, ...google, ...jigsawstack };
export function canonicalLanguage(code) {
  if (typeof code !== 'string') return null;
  const exact = Object.keys(LANGUAGE_CATALOG).find(k => k.toLowerCase() === code.toLowerCase());
  return exact || (Object.hasOwn(LANGUAGE_CATALOG, code.split('-')[0]) ? code.split('-')[0] : null);
}

// Nova-3 general, primary Deepgram catalog checked 2026-10-14. Translation targets use independent catalogs.
export const DEEPGRAM_LANGUAGES=Object.fromEntries('af ar hy as be bn bs bg ca zh hr cs da nl en et fi fr ka de el gu he hi hu id it ja kn kk ko lv lt mk ms mr mn ne no ps fa pl pt pa ro ru sr sk sl es sv tl ta te th tr uk ur vi'.split(' ').map(code=>[code,LANGUAGE_CATALOG[code] || code]));
