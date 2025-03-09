import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    IAgentRuntime,
    Memory,
    UUID,
    GoalStatus
} from '@elizaos/core';
import { createGoalAction } from '../actions/createGoal.js';
import { createRuntime } from './helpers.js';

const message: Memory = {
    id: '123' as UUID,
    content: { text: 'transfer 1 ETH to 0x1234567890123456789012345678901234567890' },
    userId: '456' as UUID,
    agentId: '789' as UUID,
    roomId: '012' as UUID
};

describe('Create Chroma Goal Action', () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(async () => {
        mockRuntime = await createRuntime();
        mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
            if (key === 'CHROMA_HOST_URL') return 'http://localhost:3000';
            return null;
        });
        mockRuntime.databaseAdapter.createGoal = vi.fn().mockResolvedValue(undefined);
    });

    describe('Action Configuration', () => {
        it('should have correct action name and similes', () => {
            expect(createGoalAction.name).toBe('CREATE_CHROMA_GOAL');
            expect(createGoalAction.similes).toContain('START_CHROMA');
            expect(createGoalAction.similes).toContain('BEGIN_CHROMA');
        });

        it('should have valid examples', () => {
            expect(createGoalAction.examples).toBeInstanceOf(Array);
            expect(createGoalAction.examples.length).toBeGreaterThan(0);

            createGoalAction.examples.forEach(example => {
                expect(example).toBeInstanceOf(Array);
                example.forEach(message => {
                    expect(message).toHaveProperty('user');
                    expect(message).toHaveProperty('content');
                    expect(message.content).toHaveProperty('text');
                });
            });
        });
    });

    describe('Validation', () => {
        it('should validate when CHROMA_HOST_URL is set', async () => {
            const isValid = await createGoalAction.validate(mockRuntime, message);
            expect(isValid).toBe(true);
        });

        it('should not validate when CHROMA_HOST_URL is missing', async () => {
            mockRuntime.getSetting = vi.fn().mockReturnValue(null);
            const isValid = await createGoalAction.validate(mockRuntime, message);
            expect(isValid).toBe(false);
        });
    });

    describe('Goal Creation', () => {
        it('should create a goal with correct structure', async () => {
            const result = await createGoalAction.handler(mockRuntime, message);
            expect(result).toBe(true);

            expect(mockRuntime.databaseAdapter.createGoal).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'Chroma Operation',
                    status: GoalStatus.IN_PROGRESS,
                    roomId: message.userId,
                    userId: message.userId,
                    objectives: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'introduce-agent',
                            completed: false
                        }),
                        expect.objectContaining({
                            id: 'present-operation',
                            description: message.content.text,
                            completed: false
                        }),
                        expect.objectContaining({
                            id: 'confirm-intent',
                            completed: false
                        }),
                        expect.objectContaining({
                            id: 'process-proposal',
                            completed: false
                        })
                    ])
                })
            );
        });

        it('should handle database errors gracefully', async () => {
            mockRuntime.databaseAdapter.createGoal = vi.fn().mockRejectedValue(new Error('Database error'));

            const result = await createGoalAction.handler(mockRuntime, message);
            expect(result).toBe(false);
        });
    });
});