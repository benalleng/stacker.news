import { decodeCursor, LIMIT, nextCursorEncoded } from '../../lib/cursor'
import { whenToFrom } from '../../lib/time'
import { getItem } from './item'

export default {
  Query: {
    related: async (parent, { title, id, cursor, limit = LIMIT, minMatch }, { me, models, search }) => {
      const decodedCursor = decodeCursor(cursor)

      if (!id && (!title || title.trim().split(/\s+/).length < 1)) {
        return {
          items: [],
          cursor: null
        }
      }

      const like = []
      if (id) {
        like.push({
          _index: process.env.OPENSEARCH_INDEX,
          _id: id
        })
      }

      if (title) {
        like.push(title)
      }

      const mustNot = [{ exists: { field: 'parentId' } }]
      if (id) {
        mustNot.push({ term: { id } })
      }

      let should = [
        {
          more_like_this: {
            fields: ['title', 'text'],
            like,
            min_term_freq: 1,
            min_doc_freq: 1,
            max_doc_freq: 5,
            min_word_length: 2,
            max_query_terms: 25,
            minimum_should_match: minMatch || '10%'
          }
        }
      ]

      if (process.env.OPENSEARCH_MODEL_ID) {
        let qtitle = title
        let qtext = title
        if (id) {
          const item = await getItem(parent, { id }, { me, models })
          qtitle = item.title || item.text
          qtext = item.text || item.title
        }

        should = [
          {
            neural: {
              title_embedding: {
                query_text: qtext,
                model_id: process.env.OPENSEARCH_MODEL_ID,
                k: decodedCursor.offset + LIMIT
              }
            }
          },
          {
            neural: {
              text_embedding: {
                query_text: qtitle,
                model_id: process.env.OPENSEARCH_MODEL_ID,
                k: decodedCursor.offset + LIMIT
              }
            }
          }
        ]
      }

      let items = await search.search({
        index: process.env.OPENSEARCH_INDEX,
        size: limit,
        from: decodedCursor.offset,
        _source: {
          excludes: [
            'text',
            'text_embedding',
            'title_embedding'
          ]
        },
        body: {
          query: {
            function_score: {
              query: {
                bool: {
                  should,
                  filter: [
                    {
                      bool: {
                        should: [
                          { match: { status: 'ACTIVE' } },
                          { match: { status: 'NOSATS' } }
                        ],
                        must_not: mustNot
                      }
                    },
                    {
                      range: { wvotes: { gte: minMatch ? 0 : 0.2 } }
                    }
                  ]
                }
              },
              functions: [{
                field_value_factor: {
                  field: 'wvotes',
                  modifier: 'none',
                  factor: 1,
                  missing: 0
                }
              }],
              boost_mode: 'multiply'
            }
          }
        }
      })

      items = items.body.hits.hits.map(async e => {
        // this is super inefficient but will suffice until we do something more generic
        return await getItem(parent, { id: e._source.id }, { me, models })
      })

      return {
        cursor: items.length === (limit || LIMIT) ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    },
    search: async (parent, { q: query, sub, cursor, sort, what, when, from: whenFrom, to: whenTo }, { me, models, search }) => {
      const decodedCursor = decodeCursor(cursor)
      let sitems

      if (!query) {
        return {
          items: [],
          cursor: null
        }
      }

      const whatArr = []
      switch (what) {
        case 'posts':
          whatArr.push({ bool: { must_not: { exists: { field: 'parentId' } } } })
          break
        case 'comments':
          whatArr.push({ bool: { must: { exists: { field: 'parentId' } } } })
          break
        default:
          break
      }

      const queryArr = query.trim().split(/\s+/)
      const url = queryArr.find(word => word.startsWith('url:'))
      const nym = queryArr.find(word => word.startsWith('nym:'))
      const exclude = [url, nym]
      query = queryArr.filter(word => !exclude.includes(word)).join(' ')

      if (url) {
        whatArr.push({ match_phrase_prefix: { url: `${url.slice(4).toLowerCase()}` } })
      }

      if (nym) {
        whatArr.push({ wildcard: { 'user.name': `*${nym.slice(4).toLowerCase()}*` } })
      }

      if (sub) {
        whatArr.push({ match: { 'sub.name': sub } })
      }

      let termQueries = [
        {
          // all terms are matched in fields
          multi_match: {
            query,
            type: 'best_fields',
            fields: ['title^100', 'text'],
            minimum_should_match: '100%',
            boost: 1000
          }
        }
      ]

      let boostMode = 'multiply'
      let sortField
      let sortMod = 'log1p'
      switch (sort) {
        case 'comments':
          sortField = 'ncomments'
          sortMod = 'square'
          break
        case 'sats':
          sortField = 'sats'
          break
        case 'recent':
          sortField = 'createdAt'
          sortMod = 'square'
          boostMode = 'replace'
          break
        default:
          sortField = 'wvotes'
          sortMod = 'none'
          break
      }

      const functions = [
        {
          field_value_factor: {
            field: sortField,
            modifier: sortMod,
            factor: 1.2
          }
        }
      ]

      if (sort === 'recent') {
        // prioritize exact matches
        termQueries.push({
          multi_match: {
            query,
            type: 'phrase',
            fields: ['title^100', 'text'],
            boost: 1000
          }
        })
      } else {
        // allow fuzzy matching with partial matches
        termQueries.push({
          multi_match: {
            query,
            type: 'most_fields',
            fields: ['title^100', 'text'],
            fuzziness: 'AUTO',
            prefix_length: 3,
            minimum_should_match: '60%'
          }
        })
        functions.push({
          // small bias toward posts with comments
          field_value_factor: {
            field: 'ncomments',
            modifier: 'ln1p',
            factor: 1
          }
        },
        {
          // small bias toward recent posts
          field_value_factor: {
            field: 'createdAt',
            modifier: 'log1p',
            factor: 1
          }
        })
      }

      if (query.length) {
        // if we have a model id and we aren't sort by recent, use neural search
        if (process.env.OPENSEARCH_MODEL_ID && sort !== 'recent') {
          termQueries = {
            hybrid: {
              queries: [
                {
                  bool: {
                    should: [
                      {
                        neural: {
                          title_embedding: {
                            query_text: query,
                            model_id: process.env.OPENSEARCH_MODEL_ID,
                            k: decodedCursor.offset + LIMIT
                          }
                        }
                      },
                      {
                        neural: {
                          text_embedding: {
                            query_text: query,
                            model_id: process.env.OPENSEARCH_MODEL_ID,
                            k: decodedCursor.offset + LIMIT
                          }
                        }
                      }
                    ]
                  }
                },
                {
                  bool: {
                    should: termQueries
                  }
                }
              ]
            }
          }
        }
      } else {
        termQueries = []
      }

      const whenRange = when === 'custom'
        ? {
            gte: whenFrom,
            lte: new Date(Math.min(new Date(whenTo), decodedCursor.time))
          }
        : {
            lte: decodedCursor.time,
            gte: whenToFrom(when)
          }

      try {
        sitems = await search.search({
          index: process.env.OPENSEARCH_INDEX,
          size: LIMIT,
          _source: {
            excludes: [
              'text',
              'text_embedding',
              'title_embedding'
            ]
          },
          from: decodedCursor.offset,
          body: {
            query: {
              function_score: {
                query: {
                  bool: {
                    ...(sort === 'recent' ? { must: termQueries } : { should: termQueries }),
                    filter: [
                      ...whatArr,
                      me
                        ? {
                            bool: {
                              should: [
                                { match: { status: 'ACTIVE' } },
                                { match: { status: 'NOSATS' } },
                                { match: { userId: me.id } }
                              ]
                            }
                          }
                        : {
                            bool: {
                              should: [
                                { match: { status: 'ACTIVE' } },
                                { match: { status: 'NOSATS' } }
                              ]
                            }
                          },
                      {
                        range:
                        {
                          createdAt: whenRange
                        }
                      },
                      { range: { wvotes: { gte: 0 } } }
                    ]
                  }
                },
                functions,
                boost_mode: boostMode
              }
            },
            highlight: {
              fields: {
                title: { number_of_fragments: 0, pre_tags: ['***'], post_tags: ['***'] },
                text: { number_of_fragments: 5, order: 'score', pre_tags: ['***'], post_tags: ['***'] }
              }
            }
          }
        })
      } catch (e) {
        console.log(e)
        return {
          cursor: null,
          items: []
        }
      }

      // return highlights
      const items = sitems.body.hits.hits.map(async e => {
        // this is super inefficient but will suffice until we do something more generic
        const item = await getItem(parent, { id: e._source.id }, { me, models })

        item.searchTitle = (e.highlight?.title && e.highlight.title[0]) || item.title
        item.searchText = (e.highlight?.text && e.highlight.text.join(' ... ')) || undefined

        return item
      })

      return {
        cursor: items.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    }
  }
}
