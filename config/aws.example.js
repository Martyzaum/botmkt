// =====================================================================
//  Template. Copie para config/aws.js e preencha. O config/aws.js real
//  fica fora do git (contém credenciais). enabled:false -> usa local/memória.
// =====================================================================
export const AWS_CONFIG = {
  enabled: false,

  region: 'us-east-1',
  accessKeyId: '',          // <preencher>
  secretAccessKey: '',      // <preencher>

  s3Bucket: '',             // <preencher>

  sqs: {
    VPS01: '',
    VPS02: '',
    VPS03: '',
    VPS04: '',
  },
};
