export class StoryConflict extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = 'StoryConflict'; }
}
