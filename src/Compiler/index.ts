/*
 * edge
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { EdgeError } from 'edge-error'
import { Parser, EdgeBuffer, Stack } from 'edge-parser'
import { Token, TagToken, utils as lexerUtils } from 'edge-lexer'

import { Processor } from '../Processor'
import { CacheManager } from '../CacheManager'
import {
  ClaimTagFn,
  TagsContract,
  LoaderContract,
  LoaderTemplate,
  CompilerOptions,
  CompilerContract,
} from '../Contracts'

/**
 * Compiler is to used to compile templates using the `edge-parser`. Along with that
 * it natively merges the contents of a layout with a parent template.
 */
export class Compiler implements CompilerContract {
  private claimTagFn?: ClaimTagFn

  /**
   * Caches compiled templates
   */
  public cacheManager = new CacheManager(!!this.options.cache)

  /**
   * Know if compiler is compiling for the async mode or not
   */
  public async = !!this.options.async

  constructor(
    private loader: LoaderContract,
    private tags: TagsContract,
    private processor: Processor,
    private options: CompilerOptions = {
      cache: true,
      async: false,
    }
  ) {}

  /**
   * Merges sections of base template and parent template tokens
   */
  private mergeSections(base: Token[], extended: Token[]): Token[] {
    /**
     * Collection of all sections from the extended tokens
     */
    const extendedSections: { [key: string]: TagToken } = {}

    /**
     * Collection of extended set calls as top level nodes. The set
     * calls are hoisted just like `var` statements in Javascript.
     */
    const extendedSetCalls: TagToken[] = []

    extended.forEach((node) => {
      /**
       * Ignore new lines, comments, layout tag and empty raw nodes inside the parent
       * template
       */
      if (
        lexerUtils.isTag(node, 'layout') ||
        node.type === 'newline' ||
        (node.type === 'raw' && !node.value.trim()) ||
        node.type === 'comment'
      ) {
        return
      }

      /**
       * Collect parent template sections
       */
      if (lexerUtils.isTag(node, 'section')) {
        extendedSections[(node as TagToken).properties.jsArg.trim()] = node
        return
      }

      /**
       * Collect set calls inside parent templates
       */
      if (lexerUtils.isTag(node, 'set')) {
        extendedSetCalls.push(node)
        return
      }

      /**
       * Everything else is not allowed as top level nodes
       */
      const [line, col] = lexerUtils.getLineAndColumn(node)

      throw new EdgeError(
        'Template extending a layout can only use "@section" or "@set" tags as top level nodes',
        'E_UNALLOWED_EXPRESSION',
        { line, col, filename: node.filename }
      )
    })

    /**
     * Replace/extend sections inside base tokens list
     */
    const finalNodes = base.map((node) => {
      if (!lexerUtils.isTag(node, 'section')) {
        return node
      }

      const sectionName = node.properties.jsArg.trim()
      const extendedNode = extendedSections[sectionName]
      if (!extendedNode) {
        return node
      }

      /**
       * Concat children when super was called
       */
      if (extendedNode.children.length) {
        if (lexerUtils.isTag(extendedNode.children[0], 'super')) {
          extendedNode.children.shift()
          extendedNode.children = node.children.concat(extendedNode.children)
        } else if (lexerUtils.isTag(extendedNode.children[1], 'super')) {
          extendedNode.children.shift()
          extendedNode.children.shift()
          extendedNode.children = node.children.concat(extendedNode.children)
        }
      }

      return extendedNode
    })

    /**
     * Set calls are hoisted to the top
     */
    return ([] as Token[]).concat(extendedSetCalls).concat(finalNodes)
  }

  /**
   * Generates an array of lexer tokens from the template string. Further tokens
   * are checked for layouts and if layouts are used, their sections will be
   * merged together.
   */
  private templateContentToTokens(content: string, parser: Parser, absPath: string): Token[] {
    let templateTokens = parser.tokenize(content, { filename: absPath })
    const firstToken = templateTokens[0]

    /**
     * The `layout` is inbuilt feature from core, where we merge the layout
     * and parent template sections together
     */
    if (lexerUtils.isTag(firstToken, 'layout')) {
      const layoutName = firstToken.properties.jsArg.replace(/'|"/g, '')
      templateTokens = this.mergeSections(this.tokenize(layoutName, parser), templateTokens)
    }

    return templateTokens
  }

  /**
   * Returns the parser instance for a given template
   */
  private getParserFor(templatePath: string, localVariables?: string[]) {
    const parser = new Parser(this.tags, new Stack(), {
      claimTag: this.claimTagFn,
      async: this.async,
      statePropertyName: 'state',
      escapeCallPath: ['template', 'escape'],
      localVariables: ['$filename', 'state', '$context'],
      onTag: (tag) => this.processor.executeTag({ tag, path: templatePath }),
    })

    /**
     * Define local variables on the parser. This is helpful when trying to compile
     * a partail and we want to share the local state of the parent template
     * with it
     */
    if (localVariables) {
      localVariables.forEach((localVariable) => parser.stack.defineVariable(localVariable))
    }

    return parser
  }

  /**
   * Returns the parser instance for a given template
   */
  private getBufferFor(templatePath: string) {
    return new EdgeBuffer(templatePath, {
      outputVar: 'out',
      rethrowCallPath: ['template', 'reThrow'],
    })
  }

  /**
   * Define a function to claim tags
   */
  public claimTag(fn: ClaimTagFn): this {
    this.claimTagFn = fn
    return this
  }

  /**
   * Converts the template content to an array of lexer tokens. The method is
   * same as the `parser.tokenize`, but it also handles layouts natively.
   *
   * ```
   * compiler.tokenize('<template-path>')
   * ```
   */
  public tokenize(templatePath: string, parser?: Parser): Token[] {
    const absPath = this.loader.makePath(templatePath)
    let { template } = this.loader.resolve(absPath)
    return this.tokenizeRaw(template, absPath, parser)
  }

  /**
   * Tokenize a raw template
   */
  public tokenizeRaw(
    contents: string,
    templatePath: string = 'eval.edge',
    parser?: Parser
  ): Token[] {
    contents = this.processor.executeRaw({ path: templatePath, raw: contents })
    return this.templateContentToTokens(
      contents,
      parser || this.getParserFor(templatePath),
      templatePath
    )
  }

  /**
   * Compiles the template contents to string. The output is same as the `edge-parser`,
   * it's just that the compiler uses the loader to load the templates and also
   * handles layouts.
   *
   * ```js
   * compiler.compile('welcome')
   * ```
   */
  public compile(
    templatePath: string,
    localVariables?: string[],
    skipCache = false
  ): LoaderTemplate {
    const absPath = this.loader.makePath(templatePath)
    let cachedResponse = skipCache ? null : this.cacheManager.get(absPath)

    /**
     * Process the template and cache it
     */
    if (!cachedResponse) {
      const parser = this.getParserFor(absPath, localVariables)
      const buffer = this.getBufferFor(absPath)

      /**
       * Generate tokens and process them
       */
      const templateTokens = this.tokenize(absPath, parser)
      templateTokens.forEach((token) => parser.processToken(token, buffer))

      const template = buffer.flush()
      if (!skipCache) {
        this.cacheManager.set(absPath, { template })
      }

      cachedResponse = { template }
    }

    const template = this.processor.executeCompiled({
      path: absPath,
      compiled: cachedResponse.template,
    })

    return { template }
  }

  /**
   * Compiles the template contents to string. The output is same as the `edge-parser`,
   * it's just that the compiler uses the loader to load the templates and also
   * handles layouts.
   *
   * ```js
   * compiler.compile('welcome')
   * ```
   */
  public compileRaw(contents: string, templatePath: string = 'eval.edge'): LoaderTemplate {
    const parser = this.getParserFor(templatePath)
    const buffer = this.getBufferFor(templatePath)
    const templateTokens = this.tokenizeRaw(contents, templatePath, parser)

    templateTokens.forEach((token) => parser.processToken(token, buffer))

    const template = this.processor.executeCompiled({
      path: templatePath,
      compiled: buffer.flush(),
    })

    return { template }
  }
}
