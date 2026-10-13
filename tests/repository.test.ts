import { describe, expect, it } from 'vitest';
import { Repository } from '../src/main/db';

describe('sqlite repository', () => {
  it('stores conversations, secrets, and routine runs', () => {
    const db = Repository.open(':memory:');
    db.insertConversation({
      id: 'c1',
      title: 'New chat',
      kind: 'direct',
      agentId: 'default',
      roomId: null,
      createdAt: 1,
      updatedAt: 1,
    });
    db.insertMessage({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      authorId: 'ada',
      authorName: 'ada',
      content: 'hello',
      createdAt: 2,
    });
    db.setSecret('session', 'encrypted-blob');
    expect(db.getSecret('session')).toBe('encrypted-blob');
    db.deleteSecret('session');
    expect(db.getSecret('session')).toBeNull();
    expect(db.listMessages('c1')[0]?.content).toBe('hello');
    db.close();
  });
});
