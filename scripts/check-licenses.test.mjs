import { describe, expect, it } from 'vitest';
import { countPackages, findViolations } from './check-licenses.mjs';

/** Shape of `pnpm licenses list --json --long`, trimmed to what the gate reads. */
const pkg = (name, versions = ['1.0.0']) => ({ name, versions });

describe('findViolations', () => {
  it('passes a wholly permissive report', () => {
    expect(
      findViolations({
        MIT: [pkg('hono'), pkg('zod')],
        'Apache-2.0': [pkg('temporal-spec')],
        ISC: [pkg('lru-cache')],
      }),
    ).toEqual([]);
  });

  it('rejects AGPL -- the scenario ADR-0003 exists to prevent', () => {
    // FullCalendar v7 moved Premium packages from GPLv3 to AGPLv3. A
    // contributor adding a resource view could pull this in without
    // noticing that it relicenses the entire project.
    const violations = findViolations({
      MIT: [pkg('hono')],
      'AGPL-3.0': [pkg('@fullcalendar/scrollgrid', ['6.1.15'])],
    });

    expect(violations).toEqual([
      { name: '@fullcalendar/scrollgrid', versions: ['6.1.15'], license: 'AGPL-3.0' },
    ]);
  });

  it('rejects GPL and LGPL', () => {
    const violations = findViolations({
      'GPL-3.0': [pkg('some-gpl-thing')],
      'LGPL-2.1': [pkg('some-lgpl-thing')],
    });
    expect(violations.map((v) => v.name)).toEqual(['some-gpl-thing', 'some-lgpl-thing']);
  });

  it('fails closed on an unrecognised license rather than assuming permissive', () => {
    // The gate must not have an implicit allow path. A license nobody has
    // classified is exactly the case where a human should look.
    expect(findViolations({ 'SEE LICENSE IN LICENSE.md': [pkg('mystery')] })).toHaveLength(1);
    expect(findViolations({ UNLICENSED: [pkg('proprietary')] })).toHaveLength(1);
    expect(findViolations({ Unknown: [pkg('no-license-field')] })).toHaveLength(1);
  });

  it('does not accept a permissive license buried in a copyleft expression', () => {
    // "(MIT OR GPL-3.0)" is dual-licensed and arguably fine, but the gate
    // only accepts expressions enumerated in ALLOWED_EXPRESSIONS. Widening
    // it is an ADR, which is the intended friction.
    expect(findViolations({ '(MIT OR GPL-3.0)': [pkg('dual')] })).toHaveLength(1);
  });

  it('accepts the enumerated dual-license expressions', () => {
    expect(
      findViolations({
        '(MIT OR Apache-2.0)': [pkg('a')],
        '(MIT OR CC0-1.0)': [pkg('b')],
      }),
    ).toEqual([]);
  });

  it('reports every offending package under one license, not just the first', () => {
    const violations = findViolations({
      'AGPL-3.0': [pkg('one'), pkg('two'), pkg('three')],
    });
    expect(violations).toHaveLength(3);
  });

  it('treats an empty report as passing without crashing', () => {
    expect(findViolations({})).toEqual([]);
    expect(countPackages({})).toBe(0);
  });
});

describe('countPackages', () => {
  it('sums across licenses', () => {
    expect(countPackages({ MIT: [pkg('a'), pkg('b')], ISC: [pkg('c')] })).toBe(3);
  });
});
