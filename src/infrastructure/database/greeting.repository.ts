/** Prisma implementation of the greeting repository; all ORM details stay here. */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { GreetingKey, GreetingRepository } from '../../modules/greetings/greeting.types.js';

export class PrismaGreetingRepository implements GreetingRepository {
  constructor(private readonly db: PrismaClient) {}

  async claim(key: GreetingKey): Promise<boolean> {
    try {
      await this.db.greeting.create({ data: key });
      return true;
    } catch (error) {
      // The compound primary key enforces this across events and process restarts.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return false;
      throw error;
    }
  }

  async markSent(key: GreetingKey): Promise<void> {
    await this.db.greeting.update({
      where: { chatId_messageId: key },
      data: { status: 'SENT', repliedAt: new Date() },
    });
  }

  async markFailed(key: GreetingKey): Promise<void> {
    await this.db.greeting.update({ where: { chatId_messageId: key }, data: { status: 'FAILED' } });
  }
}
