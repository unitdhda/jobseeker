import { type InputRichBlockTable, type RichText } from 'grammy/types';
import { config } from '../config.ts';
import {
  digestVacancies,
  getDeliverySettings,
  isApprovedUser,
  markAlerted,
  replaceDigestSnapshot,
  unsentHighScoreVacancies,
  type AlertVacancy,
} from '../database.ts';
import { getBot, targetChat, telegramRetryAfter } from './api.ts';
import { applicationKeyboard, cell, escapeHtml, headerCell, salary, sourceLabel } from './format.ts';


export async function sendHighScoreAlert(userId: string, vacancy: AlertVacancy): Promise<void> {
  if (!await isApprovedUser(userId)) throw new Error('User access is not approved.');
  const reasons = vacancy.reasons.slice(0, 3).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const gaps = vacancy.gaps.slice(0, 2).map((item) => `• ${escapeHtml(item)}`).join('\n');
  const text = [
    `<b>${vacancy.score}/100 — ${escapeHtml(vacancy.name)}</b>`,
    `ID: <code>${escapeHtml(vacancy.applyId)}</code>`,
    `${escapeHtml(vacancy.employer)} · ${escapeHtml(vacancy.area)} · ${sourceLabel(vacancy.source)}`,
    `Направление: ${escapeHtml(vacancy.primaryTrack)} · Зарплата: ${escapeHtml(salary(vacancy))}`,
    `\n<b>Комментарий к оценке</b>\n${escapeHtml(vacancy.summary)}`,
    reasons ? `\n<b>Почему подходит</b>\n${reasons}` : '', gaps ? `\n<b>На что обратить внимание</b>\n${gaps}` : '',
  ].filter(Boolean).join('\n');
  await getBot().api.sendMessage(await targetChat(userId), text, {
    reply_markup: applicationKeyboard(vacancy, true),
    parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  });
  await markAlerted(userId, vacancy.id);
}
export async function sendPendingAlerts(userId: string): Promise<number> {
  let sent = 0;
  const vacancies=await unsentHighScoreVacancies(userId, config.alertScore);
  for (const vacancy of vacancies) {
    try{await sendHighScoreAlert(userId, vacancy);sent++;}
    catch(error){
      const retryAfter=telegramRetryAfter(error);if(retryAfter==null)throw error;
      console.warn(`Telegram rate limit deferred alerts for user ${userId}; retry after ${retryAfter} seconds.`);break;
    }
    if(sent<vacancies.length)await new Promise(resolve=>setTimeout(resolve,1_100));
  }
  return sent;
}

function highlightedApplyId(applyId: string, allApplyIds: string[]): RichText {
  let prefixLength = 1;
  while (prefixLength < applyId.length && allApplyIds.some((other) =>
    other !== applyId && other.startsWith(applyId.slice(0, prefixLength)))) prefixLength++;
  return [{ type: 'bold', text: applyId.slice(0, prefixLength) }, applyId.slice(prefixLength)];
}
export interface DigestDeliveryOptions { scheduled?: boolean; sendEmptyTable?: boolean }
/**
 * Both the scheduled run and the `/digest` command list what has been scored into digest range since the last
 * scheduled run — never the snapshot that run already delivered. Only the scheduled run replaces the snapshot and
 * moves `last_digest_at`, so asking on demand shows the queue without consuming it.
 */
export async function sendDailyDigest(userId:string,options:DigestDeliveryOptions={}):Promise<number>{
  if(!await isApprovedUser(userId))throw new Error('User access is not approved.');
  const scheduled=options.scheduled??false,snapshotAt=new Date().toISOString();
  const settings=await getDeliverySettings(userId);
  const vacancies=await digestVacancies(userId,config.digestMinScore,config.alertScore,settings?.lastDigestAt??null,snapshotAt);
  if(!vacancies.length){
    if(options.sendEmptyTable){
      const table:InputRichBlockTable={type:'table',is_bordered:true,is_striped:true,cells:[
        [headerCell('ID','left'),headerCell('Балл','right'),headerCell('Вакансия','left'),headerCell('Ссылка','center')],
        [cell('—'),cell('—','right'),cell('Нет новых вакансий для дайджеста'),cell('—','center')],
      ]};
      await getBot().api.sendRichMessage(await targetChat(userId),{blocks:[table]},{disable_notification:true});
    }
    if(scheduled)await replaceDigestSnapshot(userId,[],snapshotAt);
    return 0;
  }
  const applyIds=vacancies.map(vacancy=>vacancy.applyId);
  for(let offset=0;offset<vacancies.length;offset+=30){
    const page=vacancies.slice(offset,offset+30);
    const table:InputRichBlockTable={
      type:'table',is_bordered:true,is_striped:true,
      cells:[[headerCell('ID','left'),headerCell('Балл','right'),headerCell('Вакансия','left'),headerCell('Ссылка','center')],
        ...page.map(vacancy=>[cell(highlightedApplyId(vacancy.applyId,applyIds)),cell(String(vacancy.score),'right'),
          cell(vacancy.name),cell({type:'url',text:'Открыть',url:vacancy.url},'center')])],
    };
    await getBot().api.sendRichMessage(await targetChat(userId),{blocks:[
      {type:'heading',size:3,text:offset?'Ежедневная подборка — продолжение':'Ежедневная подборка вакансий'},table,
      {type:'paragraph',text:'Пришлите выделенный префикс или полный ID, чтобы получить адаптированное резюме и сопроводительное письмо.'},
    ]},{disable_notification:true});
  }
  if(scheduled)await replaceDigestSnapshot(userId,vacancies.map(vacancy=>vacancy.id),snapshotAt);
  return vacancies.length;
}

