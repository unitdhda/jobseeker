import type { CvDocument } from './document.ts';

export interface CvEvidenceIssue {
  kind: 'new-number' | 'unknown-entry' | 'unknown-contact' | 'unsupported-skill';
  value: string;
}

const aliases: Record<string,string> = {
  js:'javascript',javascript:'javascript',ts:'typescript',typescript:'typescript',
  postgres:'postgresql',postgresql:'postgresql',k8s:'kubernetes',kubernetes:'kubernetes',
  genai:'generativeai','generative-ai':'generativeai',llm:'largelanguagemodel',
  'large-language-model':'largelanguagemodel',rag:'retrievalaugmentedgeneration',
  'retrieval-augmented-generation':'retrievalaugmentedgeneration',
};
const ignoredSkillWords=new Set(['and','or','with','using','tools','tooling','platforms','technologies','frameworks',
  'skills','other','including','development','engineering','management']);

function plain(value:string):string {
  return value.normalize('NFKC').toLowerCase().replace(/[*_`]/g,'').replace(/[^\p{L}\p{N}+#.%@/:_-]+/gu,' ')
    .replace(/\s+/g,' ').trim();
}
function compact(value:string):string { return plain(value).replace(/[^\p{L}\p{N}]+/gu,''); }
function words(value:string):string[] {
  const canonical=plain(value)
    .replace(/\bretrieval augmented generation\b/g,' retrievalaugmentedgeneration ')
    .replace(/\blarge language models?\b/g,' largelanguagemodel ')
    .replace(/\bgenerative ai\b/g,' generativeai ');
  return canonical.split(/\s+/).map((word)=>aliases[word]??word)
    .filter((word)=>word.length>1&&!ignoredSkillWords.has(word));
}
function numberClaims(value:string):string[] {
  return value.match(/(?<![\p{L}\p{N}])(?:[$€£₽]\s*)?\d[\d\s,.]*(?:%|\+|[kKmMbB])?(?![\p{L}\p{N}])/gu)
    ?.map((claim)=>claim.replace(/[\s,]/g,'').toLowerCase()).filter((claim)=>/\d/.test(claim))??[];
}
function allText(document:CvDocument):string[] {
  return [document.name,document.headline??'',...document.contacts,...document.sections.flatMap((section)=>[
    section.title,...section.blocks.flatMap((block)=>block.kind==='text'?[block.text]
      :block.kind==='bullets'?block.items
      :block.kind==='facts'?block.items.flatMap((item)=>[item.term,item.detail])
      :[block.title,block.subtitle??'',block.meta??'',block.text??'',...(block.bullets??[])])])];
}

/**
 * Checks claims that can be proved mechanically without asking another model. It intentionally validates identities,
 * contacts, numeric claims, and named skills only; prose paraphrases remain the tailoring model's responsibility.
 */
export function tailoredCvEvidenceIssues(document:CvDocument,authoritativeText:string):CvEvidenceIssue[] {
  const issues:CvEvidenceIssue[]=[];
  const sourcePlain=plain(authoritativeText),sourceCompact=compact(authoritativeText);
  const sourceNumbers=new Set(numberClaims(authoritativeText));
  const sourceWords=new Set(words(authoritativeText));
  const seen=new Set<string>();
  const add=(issue:CvEvidenceIssue)=>{const key=`${issue.kind}:${plain(issue.value)}`;if(!seen.has(key)){seen.add(key);issues.push(issue);}};

  for(const claim of new Set(allText(document).flatMap(numberClaims))) {
    if(!sourceNumbers.has(claim))add({kind:'new-number',value:claim});
  }
  for(const contact of document.contacts) {
    if(contact&&sourceCompact&&!sourceCompact.includes(compact(contact)))add({kind:'unknown-contact',value:contact});
  }
  for(const section of document.sections)for(const block of section.blocks) {
    if(block.kind==='entry'&&block.title&&sourcePlain&&!sourcePlain.includes(plain(block.title)))
      add({kind:'unknown-entry',value:block.title});
    if(block.kind==='facts')for(const fact of block.items)for(const skill of fact.detail.split(/[,;|]/)) {
      const tokens=words(skill);
      if(tokens.length&&tokens.some((token)=>!sourceWords.has(token)))add({kind:'unsupported-skill',value:skill.trim()});
    }
  }
  return issues;
}

export function assertTailoredCvEvidence(document:CvDocument,authoritativeText:string):void {
  const issues=tailoredCvEvidenceIssues(document,authoritativeText);
  if(!issues.length)return;
  const shown=issues.slice(0,8).map((issue)=>`${issue.kind}: ${issue.value}`).join('; ');
  const omitted=issues.length-8;
  throw new Error(`Tailored CV introduced unsupported evidence: ${shown}${omitted>0?`; and ${omitted} more`:''}`);
}
