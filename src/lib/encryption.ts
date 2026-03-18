import crypto from 'crypto';

/**
 * Gateway Token 加密工具
 * 
 * 使用 AES-256-GCM 加密存储 Token
 * 使用环境变量 OPENCLAW_ENCRYPTION_KEY 作为密钥
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * 获取加密密钥（从环境变量）
 * 如果未设置，生成一个临时密钥（仅用于开发）
 */
function getEncryptionKey(): Buffer {
  let key = process.env.OPENCLAW_ENCRYPTION_KEY;
  
  if (!key) {
    // 开发环境：使用默认密钥（不安全，仅用于本地测试）
    console.warn('[WARN] OPENCLAW_ENCRYPTION_KEY not set, using default key (INSECURE)');
    key = 'default-dev-key-32-chars-long!!';
  }
  
  // 确保密钥长度为 32 字节（256 位）
  if (key.length < 32) {
    key = key.padEnd(32, '0');
  } else if (key.length > 32) {
    key = key.substring(0, 32);
  }
  
  return Buffer.from(key, 'utf-8');
}

/**
 * 加密 Token
 * 
 * @param token - 原始 Token
 * @returns 加密后的 Token（包含 IV 和 auth tag）
 */
export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(token, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // 组合格式：IV + AuthTag + EncryptedData
  const result = iv.toString('hex') + authTag.toString('hex') + encrypted;
  
  return result;
}

/**
 * 解密 Token
 * 
 * @param encryptedToken - 加密的 Token
 * @returns 原始 Token
 */
export function decryptToken(encryptedToken: string): string {
  const key = getEncryptionKey();
  
  // 解析 IV, AuthTag, 和加密数据
  const iv = Buffer.from(encryptedToken.substring(0, IV_LENGTH * 2), 'hex');
  const authTag = Buffer.from(
    encryptedToken.substring(IV_LENGTH * 2, (IV_LENGTH + AUTH_TAG_LENGTH) * 2),
    'hex'
  );
  const encrypted = encryptedToken.substring((IV_LENGTH + AUTH_TAG_LENGTH) * 2);
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  
  return decrypted;
}

/**
 * 生成加密密钥（用于初始化）
 * 
 * 运行一次，将输出保存到环境变量
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 验证密钥是否有效
 */
export function validateEncryptionKey(): { valid: boolean; error?: string } {
  const key = process.env.OPENCLAW_ENCRYPTION_KEY;
  
  if (!key) {
    return {
      valid: false,
      error: 'OPENCLAW_ENCRYPTION_KEY environment variable is not set',
    };
  }
  
  if (key.length < 32) {
    return {
      valid: false,
      error: 'Key must be at least 32 characters long',
    };
  }
  
  return { valid: true };
}

/**
 * 测试加密/解密功能
 */
export function testEncryption(): { success: boolean; error?: string } {
  try {
    const testToken = 'test-token-' + Date.now();
    const encrypted = encryptToken(testToken);
    const decrypted = decryptToken(encrypted);
    
    if (decrypted !== testToken) {
      return {
        success: false,
        error: 'Decrypted token does not match original',
      };
    }
    
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
