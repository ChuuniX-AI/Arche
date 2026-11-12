// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, ageHours, num, patternsOf, FRESH_HOURS, videoFromHtml, withPageData } from './research.js';

test('reads a video page: exact date, views, channel, tags', () => {
  const html = '..."publishDate":"2026-11-11T02:00:22-08:00","viewCount":"2555","ownerChannelName":"Rhumio \\"R\\" Ranks","lengthSeconds":"30",'
    + '"keywords":["outfit transition","bag transition trend"],"shortDescription":"I ranked the best \\n#OOTD #bagdrop"...';
  const p = videoFromHtml(html);
  assert.equal(p.views, 2555);
  assert.equal(p.channel, 'Rhumio "R" Ranks');
  assert.equal(p.seconds, 30);
  assert.deepEqual(p.tags, ['outfit transition', 'bag transition trend', '#ootd', '#bagdrop']);
  const v = withPageData({ id: 'a', title: 't', views: 100, ageH: null }, p, Date.parse('2026-11-11T12:00:22-08:00'));
  assert.equal(v.ageH, 10);
  assert.equal(v.vph, 256);
  assert.equal(videoFromHtml('<html>consent page</html>'), null);
});

test('a search is not evidence for its own words', () => {
  const v = (id, via) => ({ id, title: 'my outfit check today', ageH: 30, views: 5000, vph: 166, channel: id, via });
  const circular = patternsOf([v('a', ['outfit check']), v('b', ['outfit check']), v('c', ['outfit check'])]);
  assert.ok(!circular.some((p) => p.key === 'outfit check'), 'only found by searching it');
  const real = patternsOf([v('a', ['pov outfit']), v('b', ['budget fit']), v('c', ['outfit check', 'school outfits'])]);
  assert.ok(real.some((p) => p.key === 'outfit check' && p.videos === 3), 'found by other searches');
  const tags = patternsOf([1, 2, 3].map((n) => ({ id: 'x' + n, title: '#fashion #ootd #bagdrop look ' + n, ageH: 5, views: 900, vph: 180, channel: 'c' + n, via: ['budget look'] })));
  assert.ok(tags.some((p) => p.key === '#bagdrop'));
  assert.ok(!tags.some((p) => p.key === '#fashion' || p.key === '#ootd'), 'categories are not trends');
});

test('creator tags shared by several videos become patterns', () => {
  const v = (id, tags) => ({ id, title: 'clip ' + id, ageH: 30, views: 5000, vph: 166, channel: id, tags });
  const ps = patternsOf([v('a', ['bag transition trend']), v('b', ['bag transition trend', 'x']), v('c', ['bag transition trend'])]);
  assert.ok(ps.some((p) => p.key === 'bag transition trend' && p.videos === 3));
});

test('reads views and age from the card formats YouTube uses', () => {
  const short = parseCard({ id: 'aaaaaaaaaaa', text: 'Elegant Vs Cheap #fashion\n9.2M views · 1y ago' });
  assert.equal(short.views, 9_200_000);
  assert.equal(short.ageH, 8760);
  assert.equal(short.title, 'Elegant Vs Cheap #fashion');
  const row = parseCard({ id: 'bbbbbbbbbbb', text: 'New\nRanking bag drop outfits #ootd\n23K\n4d ago\nSome Creator', channel: 'Some Creator' });
  assert.equal(row.views, 23_000);
  assert.equal(row.ageH, 96);
  assert.equal(row.vph, Math.round(23_000 / 96));
  assert.equal(row.title, 'Ranking bag drop outfits #ootd');
  const hashtagPage = parseCard({ id: 'ccccccccccc', text: '4.1M views' });
  assert.equal(hashtagPage.views, 4_100_000);
  assert.equal(hashtagPage.ageH, null);
});

test('parses ages and counts', () => {
  assert.equal(ageHours('12 hours ago'), 12);
  assert.equal(ageHours('3 weeks ago'), 504);
  assert.equal(ageHours('2mo ago'), 1440);
  assert.equal(ageHours('5 minutes ago'), 5 / 60);
  assert.equal(num('1,234'), 1234);
  assert.equal(num('2.5K'), 2500);
});

test('patterns need several fresh videos, and old videos never count', () => {
  const v = (id, title, ageH, views = 10_000) => ({ id, title, ageH, views, vph: Math.round(views / ageH), channel: id });
  const vids = [
    v('a1', 'emergency fit but filipino #emergencyfit', 20), v('a2', 'Emergency fit with tabo #emergencyfit', 40),
    v('a3', 'my emergency fit check', 70), v('a4', 'emergency fit pero pinoy #emergencyfit', 100),
    v('o1', 'emergency fit classic #emergencyfit', FRESH_HOURS + 100), v('o2', 'emergency fit old #emergencyfit', FRESH_HOURS + 500),
    v('x1', 'random cooking video', 10),
  ];
  const ps = patternsOf(vids);
  const keys = ps.map((p) => p.key);
  assert.ok(keys.includes('emergency fit'));
  assert.ok(keys.includes('#emergencyfit'));
  const tag = ps.find((p) => p.key === '#emergencyfit');
  assert.equal(tag.videos, 3, 'the two old videos are left out');
  assert.ok(!ps.some((p) => p.ids.includes('o1')));
  assert.ok(!keys.includes('random cooking'));
});
