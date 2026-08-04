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

test('coinciding markers merge into a half-filled circle',()=>{
  const overlapping=hours.map(hour=>({...hour,costUsd:0.12}));
  const chart=usageTimelineChart(overlapping,'+00:00');
  const plot=chart.split('\n').slice(3,15).join('\n');
  assert.equal((plot.match(/◐/gu)??[]).length,7);
  assert.equal((plot.match(/○/gu)??[]).length,0);
  assert.equal((plot.match(/●/gu)??[]).length,0);
});

test('shared cells are drawn with the heavy stroke',()=>{
  const overlapping=hours.map(hour=>({...hour,costUsd:0.12}));
  const plot=usageTimelineChart(overlapping,'+00:00').split('\n').slice(3,15).join('\n');
  assert.equal((plot.match(/━/gu)??[]).length,42); // the whole shared run minus the seven merged markers
  assert.equal((plot.match(/─/gu)??[]).length,0);
});

test('cells owned by a single series keep the light stroke',()=>{
  const diverging=hours.map((hour,index)=>({...hour,costUsd:index<12?0:0.12}));
  const rows=usageTimelineChart(diverging,'+00:00').split('\n').slice(3,15);
  const plot=rows.map(row=>row.slice(row.indexOf('│')+1,row.lastIndexOf('│'))).join('\n');
  assert.match(plot,/━/u);assert.match(plot,/─/u);
  for(const row of plot.split('\n'))assert.match(row,/^[ │╭╮─╯╰○●◐┃┏┓━┛┗]*$/u);
});

test('usage timeline connects steep hourly slopes with verticals and corners',()=>{
  const steep=hours.map((hour,index)=>({...hour,tokens:index===12?12_000:0}));
  const chart=usageTimelineChart(steep,'+00:00');
  assert.match(chart,/│/u);assert.match(chart,/╭●/u);
});

// The money series is parked on the top row by a flat $0.12, so these shapes belong to the tokens.
const plotOf=(points:typeof hours):string[]=>usageTimelineChart(points,'+00:00').split('\n').slice(3,15)
  .map(row=>row.slice(row.indexOf('│')+1,row.lastIndexOf('│')));

test('a falling edge turns down over the point it lands on',()=>{
  const plot=plotOf(hours.map((hour,index)=>({...hour,tokens:index<16?10_000:0,costUsd:0.12})));
  assert.equal(plot[2]![31],'─'); // the row is held across the connector
  assert.equal(plot[2]![32],'╮'); // and turns down on the landing point's own column
  assert.equal(plot[6]![32],'│');
  assert.equal(plot[11]![32],'●'); // the point itself closes the drop
  assert.equal(plot[11]![31],' ');
});

test('a rising edge turns up in the connector right after the point',()=>{
  const plot=plotOf(hours.map((hour,index)=>({...hour,tokens:index<=16?0:10_000,costUsd:0.12})));
  assert.equal(plot[11]![32],'●');
  assert.equal(plot[11]![33],'╯');
  assert.equal(plot[6]![33],'│');
  assert.equal(plot[2]![33],'╭');
});
