import { WorksDeposits } from './works-deposits';

describe('WorksDeposits', () => {
  const impl = {
    ofPermits: () => Promise.resolve(new Map()),
    deductForClaim: () => Promise.reject(new Error('unused')),
  };
  const readers = {
    unitOf: () => Promise.resolve(null),
    openClaims: () => Promise.resolve(0),
  };

  it('refuses to start without both sides, and takes each once', () => {
    const works = new WorksDeposits();
    expect(() => works.onApplicationBootstrap()).toThrow(/not implemented/);
    works.implement(impl);
    expect(() => works.onApplicationBootstrap()).toThrow(/missing/);
    works.registerPermits(readers);
    expect(() => works.onApplicationBootstrap()).not.toThrow();
    expect(() => works.implement(impl)).toThrow(/twice/);
    expect(() => works.registerPermits(readers)).toThrow(/twice/);
  });

  it('asks finance nothing for no permit', async () => {
    const works = new WorksDeposits();
    await expect(works.ofPermits({} as never, [])).resolves.toEqual(new Map());
  });
});
