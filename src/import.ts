import { App, Notice, stringifyYaml, TFile } from 'obsidian';
import { PocketbookCloudApiClient, PocketbookCloudBook, PocketbookCloudLoginClient, PocketbookCloudNote } from './apiclient';
import PocketbookCloudHighlightsImporterPlugin from './main';
import { PocketbookCloudHighlightsImporterPluginSettings } from './settings';

const CFI = require('epub-cfi-resolver');

function dataViewStructure(folder: string, book: PocketbookCloudBook) {
  return (
    '```dataviewjs\n' +
    'dv.header(2, dv.current().title)\n' +
    'const queryResult = await dv.query(`\n' +
    '  TABLE WITHOUT ID text, note\n' +
    `  FROM "${folder}/highlights"\n` +
    `  WHERE book_id="${book.id}" AND type = "highlight" and plugin = "pocketbook-cloud-highlights-importer"\n` +
    '  SORT sort_order\n' +
    '`);\n\n' +
    'const result = queryResult.value.values.map(line => "> [!quote]\\n> " + line[0].replace(/\\n/g, "\\n> ") + (line[1] ? "\\n\\n> [!note]\\n> " + line[1].replace(/\\n/g, "\\n> ") : ""))\n\n' +
    'dv.list(result)\n' +
    '```\n'
  );
}

function book_frontmatter(book: PocketbookCloudBook) {
  const book_yaml_frontmatter = {
    title: book.title,
    authors: book.metadata.authors,
    isbn: book.metadata.isbn,
    year: book.metadata.year,
    id: book.id,
    fast_hash: book.fast_hash,
    collections: (book.collections ?? '').split(','),
    uploaded_at: book.created_at,
    read_status: book.read_status,
    type: 'book',
    plugin: 'pocketbook-cloud-highlights-importer',
  };
  // not using multiline strings because they mess up indentation
  return '---\n' + stringifyYaml(book_yaml_frontmatter) + '---\n';
}

export class PocketbookCloudHighlightsImporter {
  login_client: PocketbookCloudLoginClient;
  api_client: PocketbookCloudApiClient;

  constructor(private app: App, private plugin: PocketbookCloudHighlightsImporterPlugin, private settings: PocketbookCloudHighlightsImporterPluginSettings) {
    this.login_client = new PocketbookCloudLoginClient(
      plugin,
      settings.username,
      null,
      settings.shop_name,
      settings.access_token,
      settings.refresh_token,
      settings.access_token_valid_until
    );
    this.api_client = new PocketbookCloudApiClient(this.login_client);
  }

  async importHighlights() {
    new Notice('Importing highlights...');
    const books = await this.api_client.getBooks();

    new Notice('Importing ' + books.length + ' books.');

    for (const book of books) {
      new Notice(`Importing ${book.title}`);
      const highlightIds = await this.api_client.getHighlightIdsForBook(book.fast_hash);

      const highlights = await Promise.all(highlightIds.map(highlightInfo => this.api_client.getHighlight(highlightInfo.uuid, book.fast_hash)));
      if (highlights.length > 0) {
        const sanitized_book_title = book.title.replace(/[.#%&{}\\<>*?/$!'":@+`|=]/g, '');
        if (this.plugin.settings.flat_structure) {
          await this.writeFlatHighlights(book, sanitized_book_title, highlights);
        } else {
          await this.writeNestedHighlights(book, sanitized_book_title, highlights);
        }
      }
    }
  }

  private async writeNestedHighlights(book: PocketbookCloudBook, title: string, highlights: PocketbookCloudNote[]) {
    const folder = `${this.settings.import_folder}/${title}`;
    this.createFolder(folder);
    this.createFolder(`${folder}/highlights`);

    const metadata_filename = `${folder}/metadata.md`;

    // does not work for now, see API client comment
    //const cover_filename = `${folder}/cover.jpg`;
    //await this.writeFileBinary(cover_filename, await this.api_client.getBookCover(book));

    const content = book_frontmatter(book) + dataViewStructure(folder, book);

    await this.writeFile(metadata_filename, content);

    //TODO: only create the CFI object once m)
    try {
      // if sorting works, fine. if not, also fine, using date then.
      highlights.sort((a, b) => CFI.compare(this.cfi(a.quotation.begin), this.cfi(b.quotation.begin)));
    } catch (e) {
      highlights.sort((a, b) => +a.quotation?.updated - +b.quotation?.updated);
    }

    let i = 0;
    for (const highlight of highlights) {
      i++;
      const file_name = `${folder}/highlights/${highlight.uuid}.md`;
      const highlight_yaml_frontmatter = {
        id: highlight.uuid,
        book_id: book.id,
        book_fast_hash: book.fast_hash,
        color: highlight.color?.value ?? 'unknown',
        note: highlight.note?.text ?? '',
        text: highlight.quotation?.text ?? '',
        pointer: {
          begin: highlight.quotation?.begin ?? '',
          end: highlight.quotation?.end ?? '',
        },
        updated: highlight.quotation?.updated,
        type: 'highlight',
        plugin: 'pocketbook-cloud-highlights-importer',
        sort_order: i,
      };
      const content = // not using multiline strings because they mess up indentation
        '---\n' +
        stringifyYaml(highlight_yaml_frontmatter) +
        '---\n\n' +
        `> [!quote]\n> ${(highlight.quotation?.text ?? '').replace(/\n/g, '\n> ')}\n\n` + //
        (highlight.note?.text ? `> [!note]\n> ${(highlight.note?.text ?? '').replace(/\n/g, '\n> ')}\n` : '');
      await this.writeFile(file_name, content);
    }
  }

  private async writeFlatHighlights(book: PocketbookCloudBook, title: string, highlights: PocketbookCloudNote[]) {
    const folder = `${this.settings.import_folder}`;
    await this.createFolder(folder);

    const file_name = `${folder}/${title}.md`;

    // write metadata file, which should be used to get all highlights together
    const content = book_frontmatter(book) + `Authors: [[${book.metadata.authors}]]\n`;

    await this.writeFile(file_name, content);

    //TODO: only create the CFI object once m)
    try {
      // if sorting works, fine. if not, also fine, using date then.
      highlights.sort((a, b) => CFI.compare(this.cfi(a.quotation.begin), this.cfi(b.quotation.begin)));
    } catch (e) {
      highlights.sort((a, b) => +a.quotation?.updated - +b.quotation?.updated);
    }

    for (const highlight of highlights) {
      const content = // not using multiline strings because they mess up indentation
        `> [!quote]\n> ${(highlight.quotation?.text ?? '').replace(/\n/g, '\n> ')}\n\n` + //
        (highlight.note?.text ? `> [!note]\n> ${(highlight.note?.text ?? '').replace(/\n/g, '\n> ')}\n` : '');
      await this.writeOrAppendFile(file_name, content);
    }
  }

  private async createFolder(folder: string) {
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
  }

  private async writeFile(file_name: string, content: string) {
    const file = this.app.vault.getAbstractFileByPath(file_name);
    if (!file) {
      await this.app.vault.create(file_name, content);
    } else if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      throw new Error(`File ${file_name} is not a TFile, can only write to files.`);
    }
  }

  private async writeOrAppendFile(file_name: string, content: string) {
    const file = this.app.vault.getAbstractFileByPath(file_name);
    if (!file) {
      await this.app.vault.create(file_name, content);
    } else if (file instanceof TFile) {
      await this.appendToFile(file, content);
    } else {
      throw new Error(`File ${file_name} is not a TFile, can only write to files.`);
    }
  }

  async appendToFile(file: TFile, content: string) {
    const existingContent = await this.app.vault.read(file);
    await this.app.vault.modify(file, existingContent + '\n' + content);
  }


  // TODO: Remove, if image not needed, see above: "does not work for now, see API client comment"
  private async writeFileBinary(file_name: string, content: ArrayBuffer) {
    const file = this.app.vault.getAbstractFileByPath(file_name) as TFile;
    if (!file) {
      await this.app.vault.createBinary(file_name, content);
    } else if (file instanceof TFile) {
      await this.app.vault.modifyBinary(file, content);
    } else {
      throw new Error(`File ${file_name} is not a TFile, can only write to files.`);
    }
  }

  private cfi(cfi: string) {
    return new CFI(cfi.substring(cfi.indexOf('epubcfi')));
  }
}
