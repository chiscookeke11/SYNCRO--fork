import { renewalExecutor } from '../src/services/renewal-executor';

// Mock supabase
jest.mock('../src/config/database', () => ({
  supabase: { from: jest.fn() },
}));

// Mock logger
jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// Mock blockchain service
jest.mock('../src/services/blockchain-service', () => ({
  blockchainService: {
    syncSubscription: jest.fn(),
  },
}));

// Mock DatabaseTransaction to pass supabase mock as client
jest.mock('../src/utils/transaction', () => ({
  DatabaseTransaction: {
    execute: jest.fn().mockImplementation((cb: any) => {
      const { supabase } = require('../src/config/database');
      return cb(supabase);
    }),
  },
}));

import { supabase } from '../src/config/database';
import { blockchainService } from '../src/services/blockchain-service';

describe('RenewalExecutor', () => {
  const mockRequest = {
    subscriptionId: 'sub-123',
    userId: 'user-456',
    approvalId: 'approval-789',
    amount: 9.99,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should execute renewal successfully', async () => {
    // approval check
    const approvalQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { approval_id: 'approval-789', max_spend: 15.0, expires_at: null, used: false },
        error: null,
      }),
    };

    // billing window check
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          status: 'active',
          next_billing_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
        error: null,
      }),
    };

    // update + log inserts
    const updateQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const insertQuery = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    let callCount = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      callCount++;
      if (table === 'renewal_approvals') return approvalQuery;
      if (table === 'subscriptions' && callCount <= 3) return subscriptionQuery;
      if (table === 'subscriptions') return updateQuery;
      return insertQuery; // renewal_logs
    });

    (blockchainService.syncSubscription as jest.Mock).mockResolvedValue({
      success: true,
      transactionHash: 'tx-hash-123',
    });

    const result = await renewalExecutor.executeRenewal(mockRequest);

    expect(result.success).toBe(true);
    expect(result.subscriptionId).toBe(mockRequest.subscriptionId);
    expect(result.transactionHash).toBe('tx-hash-123');
  });

  it('should fail with invalid approval', async () => {
    const approvalQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
    };
    const logQuery = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'renewal_approvals') return approvalQuery;
      return logQuery;
    });

    const result = await renewalExecutor.executeRenewal(mockRequest);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('invalid_approval');
  });

  it('should fail when billing window invalid', async () => {
    const approvalQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { approval_id: 'approval-789', max_spend: 15.0, expires_at: null, used: false },
        error: null,
      }),
    };
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          status: 'active',
          next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
        error: null,
      }),
    };
    const logQuery = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'renewal_approvals') return approvalQuery;
      if (table === 'subscriptions') return subscriptionQuery;
      return logQuery;
    });

    const result = await renewalExecutor.executeRenewal(mockRequest);

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('billing_window_invalid');
  });

  it('should retry on retryable failures', async () => {
    const approvalQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
    };
    const logQuery = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'renewal_approvals') return approvalQuery;
      return logQuery;
    });

    const result = await renewalExecutor.executeRenewalWithRetry(mockRequest, 3);

    expect(result).toBeDefined();
    expect(result.success).toBe(false);
  });
});
