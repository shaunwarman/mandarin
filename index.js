const path = require('path');
const fs = require('fs');

const _ = require('lodash');
const emoji = require('remark-emoji');
const globby = require('globby');
const languages = require('@cospired/i18n-iso-languages');
const modifyFilename = require('modify-filename');
const pMapSeries = require('p-map-series');
const pify = require('pify');
const remark = require('remark');
const remarkPresetGitHub = require('remark-preset-github');
const textr = require('remark-textr');
const { v2 } = require('@google-cloud/translate');

const isoCodes = Object.keys(languages.getAlpha2Codes());
const readFile = pify(fs.readFile);
const writeFile = pify(fs.writeFile);

class Mandarin {
  constructor(config = {}) {
    this.config = {
      i18n: false,
      logger: console,
      //
      // OPTIONAL:
      // see all commented options from this following link:
      // https://googleapis.dev/nodejs/translate/5.0.1/v2_index.js.html
      //
      clientConfig: {},
      //
      // Files to convert from `index.md` to `index-es.md`
      // Or `README.md` to `README-ZH.md` for example
      // https://github.com/sindresorhus/globby
      //
      markdown: {
        patterns: [
          '*.md',
          '**/*.md',
          ...isoCodes.map(code => `!*-${code}.md`),
          ...isoCodes.map(code => `!*-${code.toUpperCase()}.md`),
          '!test',
          '!coverage',
          '!node_modules'
        ],
        options: {
          gitignore: true
        }
      },
      ...config
    };

    if (!this.config.i18n) throw new Error('i18n instance option required');

    // setup google translate with api key
    this.client = new v2.Translate(this.config.clientConfig);

    this.translate = this.translate.bind(this);
    this.markdown = this.markdown.bind(this);
    this.parseMarkdownFile = this.parseMarkdownFile.bind(this);
    this.getLocalizedMarkdownFileName = this.getLocalizedMarkdownFileName.bind(
      this
    );
  }

  getLocalizedMarkdownFileName(filePath, locale) {
    return modifyFilename(filePath, (filename, extension) => {
      const isUpperCase = filename.toUpperCase() === filename;
      return `${filename}-${
        isUpperCase ? locale.toUpperCase() : locale.toLowerCase()
      }${extension}`;
    });
  }

  async parseMarkdownFile(filePath) {
    const markdown = await readFile(filePath);
    // don't translate the main file.md file, only for other locales
    const locales = this.config.i18n.config.locales.filter(
      locale => locale !== this.config.i18n.config.defaultLocale
    );
    const files = await Promise.all(
      locales.map(locale => {
        return new Promise((resolve, reject) => {
          remark()
            .use(remarkPresetGitHub)
            .use(emoji)
            .use(textr, {
              plugins: [phrase => this.config.i18n.api.t({ phrase, locale })]
            })
            .process(markdown, (err, content) => {
              if (err) return reject(err);
              resolve({ locale, content });
            });
        });
      })
    );
    await Promise.all(
      files.map(async file => {
        await writeFile(
          this.getLocalizedMarkdownFileName(filePath, file.locale),
          file.content
        );
      })
    );
  }

  async markdown() {
    // if title is all uppercase then `-EN` otherwise `-en`
    const filePaths = await globby(
      this.config.markdown.patterns,
      this.config.markdown.options
    );
    await Promise.all(
      filePaths.map(filePath => this.parseMarkdownFile(filePath))
    );
  }

  async translate() {
    const { i18n, logger } = this.config;

    const defaultFields = _.zipObject(
      _.values(i18n.config.phrases),
      _.values(i18n.config.phrases)
    );

    const defaultLocaleFilePath = path.join(
      i18n.config.directory,
      `${i18n.config.defaultLocale}.json`
    );

    let defaultLocaleFile;
    try {
      defaultLocaleFile = require(defaultLocaleFilePath);
    } catch (err) {
      logger.error(err);
      defaultLocaleFile = {};
    }

    return pMapSeries(i18n.config.locales, async locale => {
      const filePath = path.join(i18n.config.directory, `${locale}.json`);

      // look up the file, and if it does not exist, then
      // create it with an empty object
      let file;
      try {
        file = require(filePath);
      } catch (err) {
        logger.error(err);
        file = {};
      }

      // add any missing fields if they don't exist
      file = _.defaultsDeep(file, defaultFields);

      // if the locale is not the default
      // then check if translations need done
      if (locale === i18n.config.defaultLocale) return file;

      const translationsRequired = _.intersection(
        _.uniq(
          _.concat(_.values(i18n.config.phrases), _.values(defaultLocaleFile))
        ),
        _.values(file)
      );

      if (translationsRequired.length === 0) return file;

      // attempt to translate all of these in the given language
      await pMapSeries(translationsRequired, async phrase => {
        // TODO: prevent %s %d and %j from getting translated
        // <https://nodejs.org/api/util.html#util_util_format_format>
        // <https://github.com/nodejs/node/issues/17601>
        //
        // TODO: also prevent {{...}} from getting translated
        // by wrapping such with `<span class="notranslate">`?

        // get the translation results from Google
        const [translation] = await this.client.translate(phrase, locale);

        // replace `|` pipe character because translation will
        // interpret as ranged interval
        // <https://github.com/mashpie/i18n-node/issues/274>
        // TODO: maybe use `he` package to re-encode entities?
        file[phrase] = translation.replace(/\|/g, '&#124;');

        // write the file again
        await writeFile(filePath, JSON.stringify(file, null, 2));
      });

      return file;
    });
  }
}

module.exports = Mandarin;
