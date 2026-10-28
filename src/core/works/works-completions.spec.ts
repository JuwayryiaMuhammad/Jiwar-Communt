import { WorksCompletions } from './works-completions';

describe('WorksCompletions', () => {
  it('refuses to start without its reader, and takes one only', () => {
    const works = new WorksCompletions();
    expect(() => works.onApplicationBootstrap()).toThrow(/missing/);
    works.register(() => Promise.resolve(null));
    expect(() => works.onApplicationBootstrap()).not.toThrow();
    expect(() => works.register(() => Promise.resolve(null))).toThrow(/twice/);
  });
});
