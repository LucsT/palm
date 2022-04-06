const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  cozyClient,
  saveFiles
} = require('cozy-konnector-libs')
const KJUR = require('jsrsasign')
const request = requestFactory({
  json: true
})

const crypto = require('crypto')
const VENDOR = 'PALM'
const services = ['inokufu', 'jobready', 'orientoi']
const baseUrl = 'https://visionstrust.com/v1'
const serviceKey =
  'SlQ03OMYYo3MAGSdM2UqUuVEGf2Je81N63tUa81D8LgK8CAbxPoSELxmLPtpLGvXdp8ckPAvs6BtuHTeNTjPcoS1SwwumLZjjRd4'
const secretKey = 'LjldXJAX6MJm2qi'
const client = cozyClient.new

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Start konnector')

  try {
    const email = fields.login
    const url = process.env.COZY_URL.replace(/(^\w+:|^)\/\//, '')

    const cozyFields = JSON.parse(process.env.COZY_FIELDS || '{}')
    const account = cozyFields.account
    const payload = JSON.parse(process.env.COZY_PAYLOAD || '{}')
    const options = JSON.parse(process.env.COZY_OPTIONS || '{}')

    log('debug', `Payload: ${JSON.stringify(payload)}`)

    if (payload.signedConsent && payload.dataImportUrl) {
      log('info', `Start data export`)
      const token = generateJWT(serviceKey, secretKey)
      const validation = await validateExportConsent(payload, token)

      const data = await exportData(fields, payload, email)
      log('debug', `Export data: ${JSON.stringify(data)}`)
      return
    } else if (payload.signedConsent) {
      log('info', `Start consent export`)
      const token = generateJWT(serviceKey, secretKey)
      const consent = await consentExport(account, payload, token)
      log('debug', `Consent validate: ${JSON.stringify(consent)}`)
      return
    }

    log('info', `Start consent exchange`)

    const token = generateJWT(serviceKey, secretKey)

    log('info', 'Get user')
    const user = await getOrCreateUser(token, { email, userServiceId: url })
    if (!user) {
      throw new Error('No user found')
    }
    log('info', `user : ${JSON.stringify(user)}`)

    log('info', 'Get export purposes')
    const exportPurposes = await getExportPurposes(token)
    if (!exportPurposes || exportPurposes.length < 1) {
      throw new Error('No purpose found')
    }

    const purposes = exportPurposes.export.find(ele => ele.service === VENDOR)
    if (!purposes || purposes.length < 1) {
      throw new Error('No purpose found')
    }
    // Choice between purposes to be done here

    const purposeId = purposes.purposes[0].id

    log('info', 'Get export infos')
    const popup = await popupExport(token, {
      purpose: purposeId,
      emailExport: email
    })
    const serviceId = popup.serviceImportId


    const datatypes = popup.datatypes.map(type => {
        return { ...type, checked: true }
      })
    if (!datatypes || datatypes.length < 1) {
      throw new Error('No datatype')
    }

    const webhook = await getOrCreateWebhook(fields, account)
    const webhookUrl = webhook.links.webhook
    log('debug', `Webhook available on ${webhookUrl}`)

    const hasExportEndpoint = user.endpoints.dataExport.find(item => {
            return item.serviceId === serviceId && item.url === webhookUrl
    })
    const hasConsentExportEndpoint = user.endpoints.dataExport.find(item => {
            return item.serviceId === serviceId && item.url === webhookUrl
    })

    if (!hasExportEndpoint || !hasConsentExportEndpoint) {
      await updateUserEndpointForService(token, {
        user,
        serviceId,
        url: webhookUrl
      })
    }

    log('info', 'Create export consent')
    const consent = await createExportConsent(token, {
      datatypes,
      emailImport: popup.emailImport,
      emailExport: user.email,
      purpose: purposeId,
      userKey: user.userKey,
      isNewAccount: false
    })
    log('debug', `Consent: ${JSON.stringify(consent)}`)
    log('info', 'Done!')
  } catch (err) {
    log('error', err && err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
}

const getAccountWebhook = async accountId => {
  const selector = {
    worker: 'konnector',
    type: '@webhook'
  }
  const webhooks = await client.collection('io.cozy.triggers').find(selector)
  return webhooks.data.find(webhook => {
    const msg = webhook.attributes.message
    return msg && msg.account === accountId
  })
}

const getFolderId = async path => {
  const file = await client.collection('io.cozy.files').statByPath(path)
  return file.data._id
}


const getOrCreateWebhook = async (fields, accountId) => {
  const accountWebhook = await getAccountWebhook(accountId)
  if (!accountWebhook) {
    const targetDirId = await getFolderId(fields.folderPath)
    const newWebhook = await client.collection('io.cozy.triggers').create({
      worker: 'konnector',
      type: '@webhook',
      message: {
        account: accountId,
        konnector: VENDOR.toLowerCase(),
        folder_to_save: targetDirId
      }
    })
    return newWebhook.data
  }
  return accountWebhook
}

const getOrCreateUser = async (token, params) => {
  const { email, userServiceId } = params
  if (!email || !userServiceId) {
    throw new Error('Missing parameters')
  }
  let user
  try {
    user = await request.get(`${baseUrl}/users/${email}`, {
      auth: {
        bearer: token
      }
    })
    if (user) {
      return user
    }
  } catch (err) {
    if (err.statusCode == 404) {
      return request.post(`${baseUrl}/users`, {
        body: { email, userServiceId },
        auth: {
          bearer: token
        }
      })
    }
    throw new Error(err)
  }
}

const updateUserEndpointForService = async (token, params) => {
  const { user, url, serviceId } = params
  if (!user || !url || !serviceId) {
    throw new Error('Missing parameters')
  }

  const newEndpoints = { ...user.endpoints }
  const existingDataExport = newEndpoints.dataExport.find(
    item => item.serviceId === serviceId
  )
  if (existingDataExport) {
    existingDataExport.url = url
  } else {
    newEndpoints.dataExport.push({
      serviceId,
      url
    })
  }

  const existingConsentExport = newEndpoints.consentExport.find(
    item => item.serviceId === serviceId
  )
  if (existingConsentExport) {
    existingConsentExport.url = url
  } else {
    newEndpoints.consentExport.push({
      serviceId,
      url
    })
  }
  log('info', `update endpoint on serviceId ${serviceId} with URL: ${url}`)

  return request.put(`${baseUrl}/users/${user.userKey}`, {
    body: { email: user.email, endpoints: newEndpoints },
    auth: {
      bearer: token
    }
  })
}

const getPurposes = async token => {
  return request.get(`${baseUrl}/purposes/list`, {
    auth: {
      bearer: token
    }
  })
}

const getExportPurposes = async token => {
  return request.get(`${baseUrl}/popups`, {
    auth: {
      bearer: token
    }
  })
}

const popupImport = async (token, params) => {
  const { purpose, emailImport } = params
  if (!purpose || !emailImport) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/popups/import`, {
    body: { purpose, emailImport },
    auth: {
      bearer: token
    }
  })
}

const popupExport = async (token, params) => {
  const { purpose, emailExport } = params
  if (!purpose || !emailExport) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/popups/export`, {
    body: { purpose, emailExport },
    auth: {
      bearer: token
    }
  })
}

const createConsent = async (token, params) => {
  if (
    !params.datatypes ||
    !params.emailImport ||
    !params.emailExport ||
    !params.serviceExport ||
    !params.purpose ||
    !params.userKey
  ) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/consents/exchange/import`, {
    body: params,
    auth: {
      bearer: token
    }
  })
}

const createExportConsent = async (token, params) => {
  if (
    !params.datatypes ||
    !params.emailImport ||
    !params.emailExport ||
    !params.purpose ||
    !params.userKey
  ) {
    throw new Error('Missing parameters')
  }
  return request.post(`${baseUrl}/consents/exchange/export`, {
    body: params,
    auth: {
      bearer: token
    }
  })
}


const consentImport = async (accountId, params) => {
  const { serviceExportUrl, signedConsent } = params
  if (!serviceExportUrl || !signedConsent) {
    throw new Error('Missing parameters')
  }
  const webhook = await getAccountWebhook(accountId)
  const dataImportUrl = webhook.links.webhook
  return request.post(`${serviceExportUrl}`, {
    body: {
      signedConsent,
      dataImportUrl
    }
  })
}

const decryptConsent = (signedConsent) => {
  const publicKeyStg = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAs7c5/FFH8/52qhFoWXMS
zesJOCkPTB6381lRka7Egs+MQtTmcy0T+ipIpN7yWrUH2/vTcbRketbe/KdB7OEc
c6wfkH1lqPWH0BqszyKGDTO5HI+tbTcHX737FbV+X+xdx4vq7opQ65+eZ09zfagy
m5VUJiDinXlHfeAKkG2QjWR2yrjA4euIYZRaq1cj+zVHeTnHUtI/P8ANt4VGcWT7
M6HmLbrH12Ueglvv7VfSbhkjGeEYeoopXCEz2eZyOLafRSssh6YWEpaPB3G8BZRS
wCMbUajSnoUC+626AjLvXNt39wsWYCbQNtR3Zp09WtXL5arY4jJisPYxe+VWRUNb
9NYHVb1FuMFr8jCxdb0czISaRm9PKCW88Kv6qt6PC7Kzxc+kIGwf9H8nvBBxJYuU
49LRPHyEz+Di8DfsZuVCy1pkVheHwTQWycoi8jD86Rghj1vg9BYhW7n9BqQLLvxb
iF/QYTuxFaPz4YjXpfsgjx3hr30cJuSmSn2AeBgl5+e5W7qGqS8Hw9/JqCmF+0Y2
G3QLwnuaN6Ha9rTmB88HERP4OULmBNYpD+CTEdE/tglFuJYB9HrglmkXA8QK6taP
wJP5watrK2izg2w6/WFbY0mDEh6Q9hZ0ZDqBZGPuU0bIlLPCn695gVM8/420YeJZ
Gzl0WoFWTSg+E+vu9GeX55sCAwEAAQ==
-----END PUBLIC KEY-----`

  const publicKey = crypto.createPublicKey(publicKeyStg)
  let decryptedData = crypto.publicDecrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(signedConsent,'base64')
  )

  return JSON.parse(decryptedData.toString())
}


const consentExport = async (accountId, payload, token) => {

  const decryptedData = decryptConsent(payload.signedConsent)
  const consentId = decryptedData.consentId
  log('debug', `Exctrated consentId ${consentId}`)

  const tokenVisions = 'temporarytoken'
  return request.post(`${baseUrl}/consents/exchange/token`, {
    body: { consentId, token: tokenVisions },
    auth: {
      bearer: token
    }
  })
}

const importData = async (fields, params) => {
  const { data } = params
  if (!data) {
    throw new Error('Missing parameters')
  }

  const content = '```json' + '\n' + JSON.stringify(data, null, 4) + '\n```'

  const file = {
    filestream: content,
    filename: `${VENDOR}.md`,
    shouldReplaceFile: () => true
  }
  return saveFiles([file], fields, { contentType: 'text/markdown' })
}

const validateExportConsent = async (payload, token) => {
  const decryptedData = decryptConsent(payload.signedConsent)
  const consentId = decryptedData.consentId
  log('debug', `Exctrated consentId ${consentId}`)

  return request.post(`${baseUrl}/consents/exchange/validate`, {
    body: { consentId },
    auth: {
      bearer: token
    }
  })
}

const exportData = async (fields, payload, email) => {
  let data = {}
  for (const service of services) {
    log('debug', `Exporting data for ${service}`)
    const { Q } = require('cozy-client')
    const files =  await client.query(Q('io.cozy.files')
                                      .where(
                                        {cozyMetadata: {createdByApp: service}}
                                      ).indexFields(['cozyMetadata.createdByApp'])
                                     )
    if (files.data.length < 1) {
      log('debug', `No data found for service ${service}`)
      continue
    }
    const fileId = files.data[0].id
    const fileContent = await client.collection('io.cozy.files').fetchFileContentById(fileId)
    let content = await fileContent.text()
    // Remove ```json in first line
    content = content.replace(/^```json\n/,'')
    // Remove last line ```
    content = content.replace(/\n```$/,'')
    // Parsing object or array to JSON
    data[service] = JSON.parse(content)
  }

  log('debug', `Sending data to ${payload.dataImportUrl}`)
  return request.post(payload.dataImportUrl, {
    body: { data,
            signedConsent: payload.signedConsent,
            email : email
          }
    })
}

const generateJWT = (serviceKey, secretKey) => {
  var oHeader = { alg: 'HS256', typ: 'JWT' }
  var payload = {}
  var tNow = KJUR.jws.IntDate.get('now')
  payload.iat = tNow
  payload = {
    serviceKey,
    iat: tNow,
    exp: tNow + 5 * 60
  }
  var sHeader = JSON.stringify(oHeader)
  var sPayload = JSON.stringify(payload)
  var sJWT = KJUR.jws.JWS.sign('HS256', sHeader, sPayload, secretKey)
  return sJWT
}
