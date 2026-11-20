// Єдине джерело «зараз»: решта src/** бере час звідси (спека 0.4.e), тести підміняють clock.
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
