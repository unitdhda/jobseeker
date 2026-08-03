import assert from 'node:assert/strict';
import test from 'node:test';
import { usageTimelineChart } from '../src/telegram.ts';

const start=Date.parse('2026-08-02T12:00:00Z');
const hours=Array.from({length:25},(_,index)=>({
  at:new Date(start+index*3_600_000).toISOString(),tokens:12_000,costUsd:0,
}));

test('usage timeline renders a fixed dual-axis rectangle with four-hour markers',()=>{
  const chart=usageTimelineChart(hours,'+00:00'),lines=chart.split('\n');
  assert.equal(lines.length,19);
  const plotRows=lines.slice(3,15),left=plotRows[0]!.indexOf('│'),right=plotRows[0]!.lastIndexOf('│');
  assert.equal(right-left-1,49);
  for(const line of plotRows){
    assert.equal(line.indexOf('│'),left);assert.equal(line.lastIndexOf('│'),right);
    assert.match(line.slice(left+1,right),/^[ │╭╮─╯╰○●]+$/u);
  }
  assert.equal((chart.match(/●/gu)??[]).length,8); // seven plot markers plus the legend
  assert.equal((chart.match(/○/gu)??[]).length,8);
  assert.match(chart,/12\s+16\s+20\s+00\s+04\s+08\s+12/u);
});

test('money series stays in front when both lines overlap',()=>{
  const overlapping=hours.map(hour=>({...hour,costUsd:0.12}));
  const chart=usageTimelineChart(overlapping,'+00:00');
  const plot=chart.split('\n').slice(3,15).join('\n');
  assert.equal((plot.match(/○/gu)??[]).length,7);
  assert.equal((plot.match(/●/gu)??[]).length,0);
});

test('usage timeline connects steep hourly slopes with verticals and corners',()=>{
  const steep=hours.map((hour,index)=>({...hour,tokens:index===12?12_000:0}));
  const chart=usageTimelineChart(steep,'+00:00');
  assert.match(chart,/│/u);assert.match(chart,/╭●/u);
});
