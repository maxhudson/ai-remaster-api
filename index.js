//dotenv
var dotenv = require('dotenv');

dotenv.config();

//s3
var { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
var { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

var S3 = new S3Client({region: 'us-east-1'});

//dreambooth/stability ai
var fs = require('fs').promises;
var { createReadStream } = require('fs');
var { generateAsync } = require('stability-client');

//dalle/open ai
var request = require('request');
var { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  organization: "org-hffr499L376X5SEe3SSAeYvC",
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

//deepai upscaling
const deepai = require('deepai'); // OR include deepai.min.js as a script tag in your HTML

deepai.setApiKey(process.env.DEEPAI_API_KEY);

//express
const express = require('express');
const mysql = require('mysql');
const cors = require('cors');

const app = express();

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: false}));
app.use(cors());
// app.use(passport.initialize());
app.use((request, response, next) =>  {
  response.header('Content-Type', 'application/json');

  next();
});

var port = process.env.PORT || '3401';

app.listen(port, () => console.log(`API running on port ${port}`));// eslint-disable-line

//misc
var _ = require('lodash');
var fetch = require('node-fetch-commonjs');

//db
var dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || (process.env.NODE_ENV === 'test' ? 'airemaster_test' : 'airemaster'),
  type: 'mysql'
};

/* istanbul ignore next */
if (process.env.NODE_ENV === 'production') {
  dbConfig.ssl = {ca: fs.readFileSync(`${__dirname}/../rds-combined-ca-bundle.pem`)};
}

var db = mysql.createConnection({..._.omit(dbConfig, ['type']), multipleStatements: true, timezone: 'UTC'});

var s3 = {
  put: (key, body, options) => {
    return S3.send(new PutObjectCommand({
      Bucket: 'ai-remaster',
      Key: key,
      Body: body,
      ...options
    }));
  },
  getSignedUrl: (key) => {
    return getSignedUrl(S3, new GetObjectCommand({
      Bucket: 'ai-remaster',
      Key: key
    }), {expiresIn: 60 * 60 * 24 * 7});
  }
};

db.connect((error) => {
  var generate = async ({prompt, quantity=1, service='dalle', size='512', seed, upscale_index, discord_message_id}) => {
    var generations = [];

    var id = _.join(_.times(6, i => Math.floor(Math.random() * 10)), ''); //TODO

    if (service === 'dreamstudio') {
      var {images} = await generateAsync({
        prompt,
        apiKey: process.env.DREAMSTUDIO_API_KEY,
      });

      await Promise.all(_.map(images, async ({filePath}) => {
        const inputStream = createReadStream(filePath);

        await s3.put(`media/${id}/${id}.jpg`, inputStream);

        var url = await s3.getSignedUrl(`media/${id}/${id}.jpg`);

        await fs.unlink(filePath);
        await fs.rmdir(_.dropRight(filePath.split('/')).join('/'));

        generations.push({prompt, service, size, url});
      }));
    }
    else if (service === 'dalle'){
      const response = await openai.createImage({
        prompt,
        n: 1,
        size: `${size}x${size}`,
      });

      var {body, res} = await new Promise((resolve) => {
        request({url: response.data.data[0].url, encoding: null}, (err, res, body) => {
          resolve({body, res});
        });
      });

      await s3.put(`media/${id}/${id}.jpg`, body, {
        ContentType: res.headers['content-type'],
        ContentLength: res.headers['content-length'],
      });

      var url = await s3.getSignedUrl(`media/${id}/${id}.jpg`);

      generations.push({prompt, service, size, url});
    }
    else if (service === 'midjourney') {
      await query(`INSERT INTO generations (service, status, prompt, upscale_index, discord_message_id) VALUES ('midjourney', 'unstarted', ?, ?, ?)`, [prompt, upscale_index, discord_message_id]);
    }

    return generations;
  }

  app.post('/generate', async (req, res) => {
    var {prompt, quantity, service, size, upscale_index, discord_message_id} = req.body;

    var generations = await generate({prompt, quantity, service, size, upscale_index, discord_message_id});

    return res.json({generations});
  });

  app.get('/get-unstarted-midjourney-generations', async (req, res) => {
    var generations = await query(`SELECT * FROM generations WHERE status = 'unstarted'`);

    return res.json({generations});
  });

  app.post('/start-midjourney-generations', async (req, res) => {
    //var {id} = req.body;
    var generations = await query(`UPDATE generations SET status = 'started' WHERE status = 'unstarted'`);

    return res.json({generations});
  });

  app.post('/finished-midjourney-generation', async (req, res) => {
    var {url, discord_message_id} = req.body;

    var generations = await query(`UPDATE generations SET status = 'finished', url = ?, discord_message_id = ? WHERE status = 'started'`, [url, discord_message_id]);

    return res.json({generations});
  });

  app.post('/get-media', async (req, res) => {
    var media = await query(`SELECT * FROM media WHERE deleted = 0 ORDER BY id DESC`);

    media = await Promise.all(_.map(media, async (medium) => {
      var url = await s3.getSignedUrl(`media/${medium.id}/${medium.id}.${medium.file_extension || 'jpg'}`);

      return {...medium, url};
    }));

    res.send({media});
  });

  app.post('/delete-medium', async (req, res) => {
    var {id} = req.body;

    await query('UPDATE media SET deleted = 1 WHERE id = ?', [id]);

    res.send({});
  });

  app.post('/get-newly-generated-media', async (req, res) => {
    var generations = await query(`SELECT * FROM generations WHERE status = 'finished'`);

    await query(`UPDATE generations SET status = 'mediaGenerated' WHERE status = 'finished'`);

    var media = [];

    if (generations.length) {
      var {insertId: id} = await query(`INSERT INTO media (prompt, service, size, upscale_index, file_extension, discord_message_id) VALUES (?, ?, ?, ?, ?, ?)`, [generations[0].prompt, 'midjourney', 1024, generations[0].upscale_index, 'png', generations[0].discord_message_id]);

      var newMedia = await query(`SELECT * FROM media WHERE id = ?`, [id]);

      var {body, res: imageResponse} = await new Promise((resolve) => {
        request({url: generations[0].url, encoding: null}, (err, res, body) => {
          resolve({body, res});
        });
      });

      await S3.send(new PutObjectCommand({
        Bucket: 'ai-remaster',
        Key: `media/${id}/${id}.png`,
        ContentType: imageResponse.headers['content-type'],
        ContentLength: imageResponse.headers['content-length'],
        Body: body
      }));

      var url = s3.getSignedUrl(`media/${id}/${id}.png`);

      media.push({...newMedia[0], url});
    }

    return res.send({media});
  });

  const multer = require('multer');
  const upload = multer();

  app.post('/upload-source-media', upload.single('file'), async (req, res) => {
    var {fileExtension} = req.body;
    var {file} = req;

    var {insertId: id} = await query(`INSERT INTO media (type, file_extension) VALUES ('source', ?)`, [fileExtension.toLowerCase()]);

    await s3.put(`media/${id}/${id}.${fileExtension.toLowerCase()}`, file.buffer, {
      ContentType: file.mimetype
    });

    var url = await s3.getSignedUrl(`media/${id}/${id}.${fileExtension.toLowerCase()}`);

    res.send({media: [{id, type: 'source', url}]});
  });

  app.post('/upscale-media', async (req, res) => {
    // var resp = await deepai.callStandardApi("torch-srgan", {
    //   image: req.body.url,
    // });

    var post = async (url, body, headers) => {
      var requestParams = {method: 'post', mode: 'cors'};

      requestParams.body = JSON.stringify(body)
      requestParams.headers = {...headers};

      var response = await fetch(url, requestParams);

      return await response.json();
    }

    var replicateHeaders = {
      'x-picsart-api-key': `${process.env.PICSART_API_KEY}`,
      'Content-Type': `application/json`
    };

    // curl -X POST \
    // 'https://api.picsart.io/tools/1.0/removebg' \
    // -H 'x-picsart-api-key: APIKEYHERE' \
    // -F 'output_type=cutout' \
    // -F 'image_url=https://cdn140.picsart.com/13902645939997000779.jpg'

    var replicateBody = await post('https://api.replicate.com/v1/predictions', {"version": "9117a98dd15e931011b8b960963a2dec20ab493c6c0d3a134525273da1616abc", "input": {"image": req.body.url}}, replicateHeaders);

    var {url: outputUrl} = await new Promise((resolve, reject) => {
      var interval = setInterval(async () => {
        replicateBody = await (await fetch(replicateBody.urls.get, {headers: {'Authorization': `Token ${process.env.REPLICATE_API_KEY}`}})).json();

        //TODO catch clear interval, reject
        console.log(replicateBody);
        // if (replicateBody.status === 'processing') {
        //   clearInterval(interval);

        //   resolve({url: replicateBody.output});
        // }
      }, 5000);
    });
    console.log(outputUrl);
    // var {insertId: id} = await query(`INSERT INTO media (type, file_extension) VALUES ('generation', ?)`, ['jpg']); //TODO fileExtension.toLowerCase()

    // var {body, res: mediaRes} = await new Promise((resolve) => {
    //   request({url: outputUrl, encoding: null}, (err, res, body) => {
    //     resolve({body, res});
    //   });
    // });

    // await s3.put(`media/${id}/${id}.jpg`, body, {
    //   ContentType: mediaRes.headers['content-type'],
    //   ContentLength: mediaRes.headers['content-length'],
    // });

    // var url = await s3.getSignedUrl(`media/${id}/${id}.jpg`);

    // res.send({media: [{id, type: 'generation', url}]});
  });

  var query = (string, args) => {
    return new Promise((resolve, reject) => {
      db.query(string, args, (error, result) => {
          /* istanbul ignore if */
          if (error) {
            console.log(string, args); //eslint-disable-line
            console.log(error); //eslint-disable-line

            reject(error);
          }
          else {
            resolve(result);
          }
      });
    });
  }
});

// // app.post('/post', (req, res, next) => {
//   const client = new Client({intents: [GatewayIntentBits.Guilds]});

//   // client.once(Events.ClientReady, c => {
//   //   // client.users.fetch('1053131545738756197', false).then((user) => {
//   //   //   console.log(user);
//   //   //   user.send('hello world');
//   //   // });

//   //   // client.channels.fetch('@me/1053131545738756197').then(channel => {
//   //   //   console.log(channel);
//   //   //   channel.send('<content>')
//   //   // })
//   // });
//   client.login('2yOG86bA0sK4c9oooFVRb5ITdToUQp');


// // });
