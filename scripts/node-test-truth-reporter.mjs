const retainedEventTypes = new Set(['test:pass', 'test:fail', 'test:summary']);

export default async function* nodeTestTruthReporter(source) {
  for await (const event of source) {
    if (!retainedEventTypes.has(event.type)) continue;
    const { type, data } = event;
    if (type === 'test:summary') {
      yield `${JSON.stringify({ type, data })}\n`;
      continue;
    }
    if (data.details?.type === 'suite') continue;
    yield `${JSON.stringify({
      type,
      data: {
        name: data.name,
        nesting: data.nesting,
        testNumber: data.testNumber,
        skip: data.skip ?? null,
        todo: data.todo ?? null,
        file: data.file ?? null,
        details: {
          duration_ms: data.details?.duration_ms ?? null,
          type: data.details?.type ?? null,
        },
      },
    })}\n`;
  }
}
