import { createPublicKeyAuthenticator } from '@dimensiondev/mask-webauthn/backend'
import type { PersonaWithPrivateKey } from '../../database'
import { queryPersonasWithPrivateKey } from '../../database/Persona/Persona.db'
import { CryptoWorker } from '../../modules/workers'
import type { EC_Private_JsonWebKey, EC_Public_JsonWebKey, JsonWebKeyPair } from '@masknet/shared-base'
import { cryptoKeyToPublic, encodeText, isSameArrayBuffer, jwkToArrayBuffer } from '../../utils'
import {
    getSignCountOnGlobalRegistry,
    increaseSignCountOnGlobalRegistry,
    publishCredentialOnGlobalRegistry,
    publishKeyOnGlobalRegistry,
    searchCredentialOnGlobalRegistry,
    searchKeyOnGlobalRegistry,
} from '../../network/gun/version.2/webAuthn'
import { concatArrayBuffer } from '@dimensiondev/kit'
import { derive_AES_GCM_256_Key_From_ECDH_256k1_Keys } from "../../modules/CryptoAlgorithm/helper";

// implementation details
// !!!!!!!! Please let @yisiliu review this algorithm before implementing it !!!!!!!!
// 1. let _selectedPersona_ to be await selectPersona()
// Note: selectPersona() should be a function that create a popup to let the user select,
//       but you can implement it to choose the 1st persona found for now.
// 2. let _keyID_ to be the deterministic hash/random ID with _selectedPersona_.privateKey and_rpID_ as the source of the entropy.
// Note: if failed to connected to the key registry, fails the algorithm
// 3. let _key_ to be await searchKeyOnGlobalRegistry(_keyID_)
// Note: searchKeyOnGlobalRegistry() should be a function that searches the key on gun,
//       but you can implement it to a local Map<string, JsonWebKey> for now.
// 4. if _key_ is *undefined*,
//      a. let _new_ to be a newly created secp256r1 (P-256) keypair with usage "sign" and "verify"
//      b. let _jwk_ to be await crypto.subtle.exportKey("jwk", _new_.privateKey)
//      !!!!!! This step use ECDH to derive a new AES key with THEMSELF !!!!!!
//          Question(@yisiliu):
//              1. Is this key determinstic(which means I can get the same key back in the future with only _selectedPersona_.publicKey and privateKey) ?
//              2. Is this safe?
//      c. let _self_secret_key_ to be derive_aes_from_ecdh(_selectedPersona_.privateKey, _selectedPersona.publicKey, aes = 'AES-GCM', length = 256)
//      d. let _iv_ to be crypto.getRandomValues(new Uint8Array(16))
//      // encrypt jwk of resident key of AES key that generated by ECDH with myself
//      e. let _encrypted_ to be _iv_ + encrypt_aes(_self_secret_key_, _iv_, _jwk_)
//      // we have to make sure this step success before we return the key.
//      f. await publishKeyOnGlobalRegistry(_keyID_, _encrypted_)
//      g. return _new_
// 5. let _iv_ be first 16 uint8 of the _key.
// 6. let _encrypted_ to be the rest part of the _key_.
// Note: the generated key should be the same with step 4.b, otherwise it won't work.
// 7. let _self_secret_key_ to be derive_aes_from_ecdh(_selectedPersona_.privateKey, _selectedPersona.publicKey, aes = 'AES-GCM', length = 256)
// Note: if this step fails, we have nothing to do, but fails.
// 8. let _jwk_ to be decrypt_aes(_self_secret_key_, _iv_, _encrypted_)
// 9. let _keyPair_ to be importKey("jwk", _keyPair_) // ? can we get public key back ?
// 10. return _keyPair_

async function selectPersona(): Promise<PersonaWithPrivateKey> {
    // todo: show a popup to let user select one from personas
    const personas = await queryPersonasWithPrivateKey()
    return personas[0]
}

async function calculateKeyID(jwk: EC_Private_JsonWebKey, rpID: string) {
    const privateKeyBuffer = await jwkToArrayBuffer(jwk)
    const payloadBuffer = encodeText(rpID)
    const buffer = await concatArrayBuffer(privateKeyBuffer, payloadBuffer)
    return crypto.subtle.digest('SHA-256', buffer)
}

async function createNewKey(): Promise<
    [
        keyPair: JsonWebKeyPair<EC_Public_JsonWebKey, EC_Private_JsonWebKey>,
        payload: {
            iv: ArrayBuffer
            data: ArrayBuffer
        },
    ]
> {
    const { publicKey, privateKey } = await CryptoWorker.generate_ec_k256_pair()
    const secretKey = await derive_AES_GCM_256_Key_From_ECDH_256k1_Keys(privateKey, publicKey)
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const message = await jwkToArrayBuffer(privateKey)
    const encrypted = await CryptoWorker.encrypt_aes_gcm(secretKey, iv, message)
    // Uint8Array
    //    iv     encrypted
    // [0...15, 16.........]
    const data = await concatArrayBuffer(iv, encrypted)
    return [
        {
            publicKey,
            privateKey,
        },
        {
            iv,
            data,
        },
    ]
}

export const { get, create } = createPublicKeyAuthenticator({
    async getSignCount(key: CryptoKey, rpID: string, credentialID: ArrayBuffer) {
        return getSignCountOnGlobalRegistry(credentialID)
    },
    async incrementSignCount(key: CryptoKey, rpID: string, credentialID: ArrayBuffer) {
        return increaseSignCountOnGlobalRegistry(credentialID)
    },
    async getResidentKeyPair(rpID: string) {
        // one persona will generate one exactly unique credential and key which persona itself
        const persona = await selectPersona()
        const credentialID = await calculateKeyID(persona.privateKey, rpID)
        const privateKey = await crypto.subtle.importKey(
            'jwk',
            persona.privateKey,
            {
                name: 'ECDH',
                namedCurve: 'P-256',
            },
            true,
            [ 'encrypt',
                'decrypt',
                'sign',
                'verify',],
        )
        const publicKey = await crypto.subtle.importKey(
            'jwk',
            persona.publicKey,
            {
                name: 'ECDH',
                namedCurve: 'P-256',
            },
            true,
            [ 'encrypt',
                'decrypt',
                'sign',
                'verify',],
        )
        return [
            {
                privateKey,
                publicKey,
            },
            credentialID,
        ]
    },
    async getKeyPairByKeyWrap(rpID: string, candidateCredentialIDs: ArrayBuffer[]) {
        const persona = await selectPersona()
        const secretKey = await derive_AES_GCM_256_Key_From_ECDH_256k1_Keys(persona.privateKey, persona.publicKey).then(
            (key) => crypto.subtle.importKey('jwk', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
        )
        const credentialID = await searchCredentialOnGlobalRegistry(persona.publicKey, rpID)
            .then((buffers) => buffers.filter((a) => candidateCredentialIDs.find((b) => isSameArrayBuffer(a, b))))
            .then((array) => array[0])
        const key = await searchKeyOnGlobalRegistry(credentialID).then(async (buffers) => {
            for (const buffer of buffers) {
                const iv = buffer.slice(0, 15)
                const encrypted = buffer.slice(16)
                let keyBuffer: ArrayBuffer
                try {
                    keyBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, secretKey, encrypted)
                } catch (e) {
                    continue
                }
                const privateKey = await crypto.subtle.importKey(
                    'raw',
                    keyBuffer,
                    { name: 'ECDH', namedCurve: 'P-256' },
                    true,
                    [],
                )
                const publicKey = await cryptoKeyToPublic(privateKey)
                return {
                    privateKey,
                    publicKey,
                }
            }
            return null
        })
        return [key, credentialID]
    },
    async createKeyPairByKeyWrap(rpID: string, excludeCredentialIDs: ArrayBuffer[]) {
        const persona = await selectPersona()
        const secretKey = await derive_AES_GCM_256_Key_From_ECDH_256k1_Keys(persona.privateKey, persona.publicKey).then(
            (key) => crypto.subtle.importKey('jwk', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
        )
        const excludes = await searchCredentialOnGlobalRegistry(persona.publicKey, rpID).then((buffers) =>
            buffers.filter((a) => excludeCredentialIDs.find((b) => isSameArrayBuffer(a, b))),
        )
        if (excludes.length > 0) {
            throw new Error('credential have existed')
        }
        const [keys, { iv, data }] = await createNewKey()
        const credentialID = await calculateKeyID(keys.privateKey, rpID)
        await publishCredentialOnGlobalRegistry(persona.privateKey, rpID, credentialID)
        await publishKeyOnGlobalRegistry(credentialID, secretKey, iv, data)
        const privateKey = await crypto.subtle.importKey(
            'jwk',
            keys.privateKey,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            [],
        )
        const publicKey = await cryptoKeyToPublic(privateKey)
        return [
            {
                privateKey,
                publicKey,
            },
            credentialID,
        ]
    },
})
